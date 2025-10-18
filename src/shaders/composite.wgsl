	struct VSOut {
		@builtin(position) pos : vec4<f32>,
		@location(0) uv : vec2<f32>,
	};

	@vertex
	fn vs(@builtin(vertex_index) vid : u32) -> VSOut {
		var positions = array<vec2<f32>, 3>(
			vec2<f32>(-1.0, -1.0),
			vec2<f32>( 3.0, -1.0),
			vec2<f32>(-1.0,  3.0)
		);
		var out: VSOut;
		out.pos = vec4<f32>(positions[vid], 0.0, 1.0);
		out.uv = out.pos.xy * 0.5 + vec2<f32>(0.5, 0.5);
		return out;
	}

	@group(0) @binding(0) var colorTex : texture_2d<f32>;
	@group(0) @binding(1) var colorSampler : sampler;

	@fragment
	fn fs(in: VSOut) -> @location(0) vec4<f32> {
		let c = textureSample(colorTex, colorSampler, in.uv);
		// output premultiplied-like color: rgb in src, alpha = src.a
		return vec4<f32>(c.rgb, c.a);
	}