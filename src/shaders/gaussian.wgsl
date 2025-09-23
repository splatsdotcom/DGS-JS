/* gaussian.wgsl
 *
 * contains vertex and fragment shaders for rendering a single gaussian
 */

//-------------------------//

struct Params
{
	view: mat4x4f,
	proj: mat4x4f,
	focalLengths: vec2f,
	viewPort: vec2f
};

struct Gaussian
{
	cov: vec3u,
	color: u32,
	mean: vec3f
};

struct VertexOutput 
{
	@builtin(position) pos : vec4f,

	@location(0) localPos: vec2f,
	@location(1) color: vec4f
};

//-------------------------//

@binding(0) @group(0) var<uniform> u_params: Params;
@binding(1) @group(0) var<storage, read> u_gaussians: array<Gaussian>;

//-------------------------//

@vertex
fn vs_main(@location(0) quadPos: vec2<f32>, @location(1) id: u32) -> VertexOutput 
{
	//TODO: do most of this work in a preprocess shader!

	var out: VertexOutput;
	out.pos = vec4f(0.0, 0.0, 2.0, 1.0);
	out.localPos = quadPos;
	out.color = vec4f(1.0);

	//find clip pos of mean:
	//---------------
	let g = u_gaussians[id];
	let camPos = u_params.view * vec4f(g.mean, 1.0);
	let clipPos = u_params.proj * camPos;

	//basic culling:
	//---------------
	let clip = 1.2 * clipPos.w;
	if(clipPos.x >  clip || clipPos.y >  clip || clipPos.z >  clip ||
	   clipPos.x < -clip || clipPos.y < -clip || clipPos.z < -clip)
	{
		return out;
	}

	//unpack covariance matrix:
	//---------------
    let c0 = unpack2x16float(g.cov.x);
    let c1 = unpack2x16float(g.cov.y);
    let c2 = unpack2x16float(g.cov.z);

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
		return out;
	}

	let v1 = normalize(vec2f(cov2d[0][1], lambda1 - cov2d[0][0]));
	let v2 = vec2f(v1.y, -v1.x);

	let major = min(sqrt(2.0 * lambda1), 1024.0) * v1;
	let minor = min(sqrt(2.0 * lambda2), 1024.0) * v2;

	//compute vertex position + return:
	//---------------
	let centerPos = clipPos.xy / clipPos.w;
	out.pos = vec4f(
		centerPos + (quadPos.x * major + quadPos.y * minor) / u_params.viewPort,
		0.0, 1.0
	);

	let color = unpack4x8unorm(g.color);
	out.color = clamp(clipPos.z / clipPos.w + 1.0, 0.0, 1.0) * color;

	return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f
{
	let a = -dot(in.localPos, in.localPos);
	if(a < -4.0)
	{
		discard;
	}

	let b = exp(a) * in.color.a;
	return vec4f(in.color.rgb * b, b);
}
