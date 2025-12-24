/* gaussian_rasterize.wgsl
 *
 * contains vertex and fragment shaders for rendering a single gaussian
 */

//-------------------------//

struct Params
{
	view: mat4x4f,
	proj: mat4x4f,
	camPos: vec3f,
	time: f32,

	focalLengths: vec2f,
	viewPort: vec2f
};

struct RenderedGaussian
{
	//TODO: pack

	minor: vec2f,
	major: vec2f,
	color: vec4f,

	center: vec2f
};

struct VertexOutput 
{
	@builtin(position) pos : vec4f,

	@location(0) localPos: vec2f,
	@location(1) color: vec4f
};

//-------------------------//

@binding(0) @group(0) var<uniform> u_params: Params;
@binding(1) @group(0) var<storage, read> u_gaussians: array<RenderedGaussian>;

//-------------------------//

@vertex
fn vs(@location(0) quadPos: vec2<f32>, @builtin(instance_index) idx: u32) -> VertexOutput 
{
    let g = u_gaussians[idx];
	var out: VertexOutput;

    out.localPos = quadPos;

	out.pos = vec4f(
		g.center + (quadPos.x * g.major + quadPos.y * g.minor) / u_params.viewPort,
		0.0, 1.0
	);
	out.pos.x *= -1; //TODO: why do we need to do this?

	out.color = g.color;

	return out;
}

@fragment
fn fs(in: VertexOutput) -> @location(0) vec4f
{
	let a = -dot(in.localPos, in.localPos);
	if(a < -4.0)
	{
		discard;
	}

	let b = exp(a) * in.color.a;
	return vec4f(in.color.rgb * b, b);
}
