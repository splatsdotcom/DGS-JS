/* gaussian_preprocess.wgsl
 *
 * performs gaussian culling + preprocessing
 */

override WORKGROUP_SIZE: u32;

const MAX_SH_DEGREE = 3u;
const MAX_SH_COEFFS = (3 * (MAX_SH_DEGREE + 1) * (MAX_SH_DEGREE + 1));
const MAX_SH_COEFFS_REST = (MAX_SH_COEFFS - 3); //not including dc coeffs

const SH_C0 = 0.28209479177387814;

const SH_C1 = 0.4886025119029199;

const SH_C2 = array<f32, 5>(
	 1.0925484305920792,
	-1.0925484305920792,
	 0.3153915652525200,
	-1.0925484305920792,
	 0.5462742152960396
);

const SH_C3 = array<f32, 7>(
	-0.5900435899266435,
	 2.8906114426405540,
	-0.4570457994644658,
	 0.3731763325901154,
	-0.4570457994644658,
	 1.4453057213202770,
	-0.5900435899266435
);

//-------------------------//

struct Params
{
	view: mat4x4f,
	proj: mat4x4f,
	camPos: vec3f,

	shDegree: u32,

	focalLengths: vec2f,
	viewPort: vec2f
};

struct Gaussian
{
	cov: vec3u,
	colorRG: u32,
	mean: vec3f,
	colorBA: u32,
	sh: array<u32, (MAX_SH_COEFFS_REST + 1) / 2>
};

struct RenderedGaussian
{
	//TODO: pack

	minor: vec2f,
	major: vec2f,
	color: vec4f,

	center: vec2f
};

struct RenderedGaussians
{
	indirectIndexCount: u32,
	numGaussians: atomic<u32>, //or indirectInstanceCount
	indirectFirstIndex: u32,
	indirectBaseVertex: u32,
	indirectFirstInstance: u32,

	gaussians: array<RenderedGaussian>
};

//-------------------------//

@group(0) @binding(0) var<uniform> u_params: Params;
@group(0) @binding(1) var<storage, read> u_gaussians: array<Gaussian>;

@group(0) @binding(2) var<storage, read_write> u_renderedGaussians: RenderedGaussians;
@group(0) @binding(3) var<storage, read_write> u_gaussianDepths: array<u32>;
@group(0) @binding(4) var<storage, read_write> u_gaussianIndices: array<u32>;

var<workgroup> s_numGaussians: atomic<u32>;
var<workgroup> s_writePosWorkgroup: u32;

//-------------------------//

fn f32_to_u32_ordered(x: f32) -> u32 
{
	let bits : u32 = bitcast<u32>(x);
	let mask : u32 = select(0x80000000u, 0xFFFFFFFFu, x < 0.0);
	return bits ^ mask;
}

fn f16_to_u32_ordered(x: f32) -> u32 
{
    // Pack x into the low 16 bits of a u32
    let packed : u32 = pack2x16float(vec2<f32>(x, 0.0));
    var bits   : u32 = packed & 0xFFFFu;

    // Apply the ordering fix so that signed float16 values
    // compare correctly when treated as unsigned ints
    let mask : u32 = select(0x8000u, 0xFFFFu, x < 0.0);
    bits = bits ^ mask;

    return bits;
}

fn get_sh_coeffs(gaussianIdx: u32, i: u32) -> vec3f
{
	let idx = (i - 1) * 3u; //dc coeff is stored separately

	return vec3f(
		unpack2x16float(u_gaussians[gaussianIdx].sh[(idx + 0) / 2])[(idx + 0) % 2],
		unpack2x16float(u_gaussians[gaussianIdx].sh[(idx + 1) / 2])[(idx + 1) % 2],
		unpack2x16float(u_gaussians[gaussianIdx].sh[(idx + 2) / 2])[(idx + 2) % 2]
	);
}

@compute @workgroup_size(WORKGROUP_SIZE) 
fn preprocess(@builtin(global_invocation_id) GID: vec3u, @builtin(local_invocation_id) LID: vec3u)
{
	var culled = false;

	//find clip pos of mean:
	//---------------
	var idx = GID.x;
	if(idx >= arrayLength(&u_gaussians))
	{
		culled = true;
		idx = arrayLength(&u_gaussians) - 1;
	}

	let camPos = u_params.view * vec4f(u_gaussians[idx].mean, 1.0);
	let clipPos = u_params.proj * camPos;

	//cull if outside of camera view:
	//---------------
	let clip = 1.2 * clipPos.w;
	if(clipPos.x >  clip || clipPos.y >  clip || clipPos.z >  clip ||
	   clipPos.x < -clip || clipPos.y < -clip || clipPos.z < -clip)
	{
		culled = true;
	}

	//unpack covariance matrix:
	//---------------
	let c0 = unpack2x16float(u_gaussians[idx].cov.x);
	let c1 = unpack2x16float(u_gaussians[idx].cov.y);
	let c2 = unpack2x16float(u_gaussians[idx].cov.z);

	let cov = mat3x3f(
		vec3f(c0.x, c0.y, c1.x),
		vec3f(c0.y, c1.y, c2.x),
		vec3f(c1.x, c2.x, c2.y)
	);

	//project covariance matrix to 2D:
	//---------------
	let J = mat3x3f(
		-u_params.focalLengths.x / camPos.z, 0.0,                                 (u_params.focalLengths.x * camPos.x) / (camPos.z * camPos.z),
		0.0,                                -u_params.focalLengths.y / camPos.z,  (u_params.focalLengths.y * camPos.y) / (camPos.z * camPos.z),
		0.0,                                0.0,                                  0.0
	);

	let T = transpose(mat3x3f(
		u_params.view[0].xyz,
		u_params.view[1].xyz,
		u_params.view[2].xyz
	)) * J;
	let cov2d = transpose(T) * cov * T;

	//compute eigenvectors/eigenvalues:
	//---------------
	let midpoint = (cov2d[0][0] + cov2d[1][1]) / 2.0;
	let radius = length(vec2f(
		(cov2d[0][0] - cov2d[1][1]) / 2.0, cov2d[0][1]
	));

	let lambda1 = midpoint + radius;
	let lambda2 = midpoint - radius;

	if(lambda2 < 0.0) //degenerate
	{
		culled = true;
	}

	let v1 = normalize(vec2f(cov2d[0][1], lambda1 - cov2d[0][0]));
	let v2 = vec2f(v1.y, -v1.x);

	let major = min(sqrt(2.0 * lambda1), 1024.0) * v1;
	let minor = min(sqrt(2.0 * lambda2), 1024.0) * v2;

	//evalate sh:
	//---------------
	let dc = vec4f(
		unpack2x16float(u_gaussians[idx].colorRG),
		unpack2x16float(u_gaussians[idx].colorBA)
	);

	let dir = normalize(u_gaussians[idx].mean - u_params.camPos);

	var color = SH_C0 * dc.rgb;
	if(u_params.shDegree > 0)
	{
		let x = dir.x;
		let y = dir.y;
		let z = dir.z;
		color += -SH_C1 * y * get_sh_coeffs(idx, 1) + 
		          SH_C1 * z * get_sh_coeffs(idx, 2) - 
		          SH_C1 * x * get_sh_coeffs(idx, 3);

		if(u_params.shDegree > 1)
		{
            let xx = dir.x * dir.x;
            let yy = dir.y * dir.y;
            let zz = dir.z * dir.z;
            let xy = dir.x * dir.y;
            let yz = dir.y * dir.z;
            let xz = dir.x * dir.z;

            color += SH_C2[0] * xy                   * get_sh_coeffs(idx, 4) + 
			         SH_C2[1] * yz                   * get_sh_coeffs(idx, 5) + 
			         SH_C2[2] * (2.0 * zz - xx - yy) * get_sh_coeffs(idx, 6) + 
			         SH_C2[3] * xz                   * get_sh_coeffs(idx, 7) + 
			         SH_C2[4] * (xx - yy)            * get_sh_coeffs(idx, 8);

			if(u_params.shDegree > 2)
			{
				color += SH_C3[0] * y * (3.0 * xx - yy)                  * get_sh_coeffs(idx,  9) + 
				         SH_C3[1] * xy * z                               * get_sh_coeffs(idx, 10) + 
				         SH_C3[2] * y * (4.0 * zz - xx - yy)             * get_sh_coeffs(idx, 11) + 
				         SH_C3[3] * z * (2.0 * zz - 3.0 * xx - 3.0 * yy) * get_sh_coeffs(idx, 12) + 
				         SH_C3[4] * x * (4.0 * zz - xx - yy)             * get_sh_coeffs(idx, 13) + 
				         SH_C3[5] * z * (xx - yy)                        * get_sh_coeffs(idx, 14) + 
				         SH_C3[6] * x * (xx - 3.0 * yy)                  * get_sh_coeffs(idx, 15);
			}
		}
	}

	color += 0.5;

	let rgba = clamp(clipPos.z / clipPos.w + 1.0, 0.0, 1.0) * vec4f(color, dc.a);

	//determine write position within global buffer:
	//---------------
	workgroupBarrier();

	if(LID.x == 0u)
	{
		atomicStore(&s_numGaussians, 0u);
	}

	workgroupBarrier();

	var writePosLocal = 0u;
	if(!culled)
	{
		writePosLocal = atomicAdd(&s_numGaussians, 1u);
	}

	workgroupBarrier();

	if(LID.x == 0u)
	{
		let numGaussians = atomicLoad(&s_numGaussians);
		s_writePosWorkgroup = atomicAdd(&u_renderedGaussians.numGaussians, numGaussians);
	}

	workgroupBarrier();

	let writePos = s_writePosWorkgroup + writePosLocal;

	//write:
	//---------------
	if(!culled)
	{
		u_renderedGaussians.gaussians[writePos].minor = minor;
		u_renderedGaussians.gaussians[writePos].major = major;
		u_renderedGaussians.gaussians[writePos].color = rgba;
		u_renderedGaussians.gaussians[writePos].center = clipPos.xy / clipPos.w;

		u_gaussianDepths [writePos] = ~f32_to_u32_ordered(camPos.z);
		u_gaussianIndices[writePos] = writePos;
	}
}
