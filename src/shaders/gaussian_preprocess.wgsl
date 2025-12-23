/* gaussian_preprocess.wgsl
 *
 * performs gaussian culling + preprocessing
 */

override WORKGROUP_SIZE: u32;

const CLIP_THRESHHOLD = 1.2;

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
	viewPort: vec2f,

	scaleMin: f32,
	scaleMax: f32,
	colorMin: f32,
	colorMax: f32,
	shMin: f32,
	shMax: f32,

	dynamic: u32,
	time: f32,

	numGaussians: u32
};

struct RenderedGaussian
{
	//TODO: pack

	minor: vec2f,
	major: vec2f,
	color: vec4f,

	center: vec2f
};

//-------------------------//

@group(0) @binding(0) var<uniform> u_params: Params;

@group(0) @binding(1) var<storage, read> u_means         : array<vec4f>;
@group(0) @binding(2) var<storage, read> u_scales        : array<u32>;
@group(0) @binding(3) var<storage, read> u_rotations     : array<u32>;
@group(0) @binding(4) var<storage, read> u_opacities     : array<u32>;
@group(0) @binding(5) var<storage, read> u_colors        : array<u32>;
@group(0) @binding(6) var<storage, read> u_shs           : array<u32>;
@group(0) @binding(7) var<storage, read> u_velocities    : array<vec4f>;
@group(0) @binding(8) var<storage, read> u_sortedIndices : array<u32>;

@group(0) @binding(9) var<storage, read_write> u_renderedGaussians: array<RenderedGaussian>;

var<workgroup> s_numGaussians: atomic<u32>;
var<workgroup> s_writePosWorkgroup: u32;

//-------------------------//

fn read_vec3_unorm16(buf: ptr<storage, array<u32>, read>, idx: u32) -> vec3f
{
	return vec3f(vec3u(
		(buf[(idx * 3 + 0) / 2] >> (((idx * 3 + 0) % 2) * 16)) & 0xFFFF,
		(buf[(idx * 3 + 1) / 2] >> (((idx * 3 + 1) % 2) * 16)) & 0xFFFF,
		(buf[(idx * 3 + 2) / 2] >> (((idx * 3 + 2) % 2) * 16)) & 0xFFFF
	)) / 0xFFFF;
}

fn read_sh_coeffs(gaussianIdx: u32, i: u32) -> vec3f
{
	let numCoeffs = (u_params.shDegree + 1) * (u_params.shDegree + 1) - 1;
	let idx = (gaussianIdx * numCoeffs + i - 1) * 3;

	let shRead = vec3u(
		(u_shs[(idx + 0) / 4] >> (((idx + 0) % 4) * 8)) & 0xFF,
		(u_shs[(idx + 1) / 4] >> (((idx + 1) % 4) * 8)) & 0xFF,
		(u_shs[(idx + 2) / 4] >> (((idx + 2) % 4) * 8)) & 0xFF
	);

	return (vec3f(shRead) / 0xFF) * (u_params.shMax - u_params.shMin) + u_params.shMin;
}

fn quat_to_mat4(q: vec4f) -> mat3x3f
{
	let x2  = q.x + q.x;
    let y2  = q.y + q.y;
    let z2  = q.z + q.z;
    let xx2 = q.x * x2;
    let xy2 = q.x * y2;
    let xz2 = q.x * z2;
    let yy2 = q.y * y2;
    let yz2 = q.y * z2;
    let zz2 = q.z * z2;
    let sx2 = q.w * x2;
    let sy2 = q.w * y2;
    let sz2 = q.w * z2;

	var result: mat3x3f;

	result[0][0] = 1.0 - (yy2 + zz2);
	result[0][1] = xy2 - sz2;
	result[0][2] = xz2 + sy2;
	result[1][0] = xy2 + sz2;
	result[1][1] = 1.0 - (xx2 + zz2);
	result[1][2] = yz2 - sx2;
	result[2][0] = xz2 - sy2;
	result[2][1] = yz2 + sx2;
	result[2][2] = 1.0 - (xx2 + yy2);

	return result;
}

//-------------------------//

@compute @workgroup_size(WORKGROUP_SIZE) 
fn preprocess(@builtin(global_invocation_id) GID: vec3u, @builtin(local_invocation_id) LID: vec3u)
{
	//find clip pos of mean:
	//---------------
	let writeIdx = GID.x;
	if(writeIdx >= u_params.numGaussians)
	{
		return;
	}
	let idx = u_sortedIndices[writeIdx];

	var mean = u_means[idx];
	var velocity = vec4f(0.0);
	if(u_params.dynamic != 0)
	{
		velocity = u_velocities[idx];
		mean = vec4f(mean.xyz + velocity.xyz * u_params.time, mean.w);
	}

	let camPos = u_params.view * vec4f(mean.xyz, 1.0);
	let clipPos = u_params.proj * camPos;

	//unpack covariance matrix:
	//---------------
	let scales = exp(
		read_vec3_unorm16(&u_scales, idx) * (u_params.scaleMax - u_params.scaleMin) + u_params.scaleMin
	);
	let rots = read_vec3_unorm16(&u_rotations, idx) * 2.0 - 1.0;

	let scaleMat = mat3x3f(
		scales.x, 0.0, 0.0,
		0.0, scales.y, 0.0,
		0.0, 0.0, scales.z
	);
	let rotMat = quat_to_mat4(vec4f(rots, sqrt(1.0 - dot(rots, rots))));

	let M = scaleMat * rotMat;
	let cov = 4.0 * transpose(M) * M;

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

	let v1 = normalize(vec2f(cov2d[0][1], lambda1 - cov2d[0][0]));
	let v2 = vec2f(v1.y, -v1.x);

	let major = min(sqrt(2.0 * lambda1), 1024.0) * v1;
	let minor = min(sqrt(2.0 * lambda2), 1024.0) * v2;

	//evalate sh:
	//---------------
	let dc = read_vec3_unorm16(&u_colors, idx) * (u_params.colorMax - u_params.colorMin) + u_params.colorMin;
	let dir = normalize(mean.xyz - u_params.camPos);

	var color = SH_C0 * dc;
	if(u_params.shDegree > 0)
	{
		let x = dir.x;
		let y = dir.y;
		let z = dir.z;
		color += -SH_C1 * y * read_sh_coeffs(idx, 1) + 
		          SH_C1 * z * read_sh_coeffs(idx, 2) - 
		          SH_C1 * x * read_sh_coeffs(idx, 3);

		if(u_params.shDegree > 1)
		{
            let xx = dir.x * dir.x;
            let yy = dir.y * dir.y;
            let zz = dir.z * dir.z;
            let xy = dir.x * dir.y;
            let yz = dir.y * dir.z;
            let xz = dir.x * dir.z;

            color += SH_C2[0] * xy                   * read_sh_coeffs(idx, 4) + 
			         SH_C2[1] * yz                   * read_sh_coeffs(idx, 5) + 
			         SH_C2[2] * (2.0 * zz - xx - yy) * read_sh_coeffs(idx, 6) + 
			         SH_C2[3] * xz                   * read_sh_coeffs(idx, 7) + 
			         SH_C2[4] * (xx - yy)            * read_sh_coeffs(idx, 8);

			if(u_params.shDegree > 2)
			{
				color += SH_C3[0] * y * (3.0 * xx - yy)                  * read_sh_coeffs(idx,  9) + 
				         SH_C3[1] * xy * z                               * read_sh_coeffs(idx, 10) + 
				         SH_C3[2] * y * (4.0 * zz - xx - yy)             * read_sh_coeffs(idx, 11) + 
				         SH_C3[3] * z * (2.0 * zz - 3.0 * xx - 3.0 * yy) * read_sh_coeffs(idx, 12) + 
				         SH_C3[4] * x * (4.0 * zz - xx - yy)             * read_sh_coeffs(idx, 13) + 
				         SH_C3[5] * z * (xx - yy)                        * read_sh_coeffs(idx, 14) + 
				         SH_C3[6] * x * (xx - 3.0 * yy)                  * read_sh_coeffs(idx, 15);
			}
		}
	}

	color += 0.5;

	let opacityRead = (u_opacities[idx / 4] >> ((idx % 4) * 8)) & 0xFF;
	var opacity = f32(opacityRead) / 0xFF;
	if(u_params.dynamic != 0 && velocity.w > 0.0)
	{
		let tOffset = u_params.time - mean.w;
		let opacityMult = exp(-tOffset * tOffset / (2.0 * velocity.w * velocity.w));
		opacity *= opacityMult;
	}

	var rgba = clamp(clipPos.z / clipPos.w + 1.0, 0.0, 1.0) * vec4f(color, opacity);

	//culling:
	//---------------
	let isBehind = clipPos.z < -CLIP_THRESHHOLD * clipPos.w;
	let isDegenerate = lambda2 < 0.0;

	if(isBehind || isDegenerate)
	{
		rgba = vec4f(0.0);
	}

	//write:
	//---------------
	u_renderedGaussians[writeIdx].minor = minor;
	u_renderedGaussians[writeIdx].major = major;
	u_renderedGaussians[writeIdx].color = rgba;
	u_renderedGaussians[writeIdx].center = clipPos.xy / clipPos.w;
}
