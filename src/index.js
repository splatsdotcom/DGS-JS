/* index.js
 * 
 * contains the core logic
 */

const CANVAS_RESOLUTION_SCALE = 2;

const SIZEOF_FLOAT32 = Float32Array.BYTES_PER_ELEMENT;
const SIZEOF_UINT32  = Uint32Array.BYTES_PER_ELEMENT;

//-------------------------//

import { mat3, mat4, vec3, vec4 } from 'gl-matrix';
import MGSModule from './wasm/mgs.js'
import shaderCode from './shaders/gaussian.wgsl?raw';

//-------------------------//

if(!navigator.gpu) 
	throw new Error("WebGPU isn not supported!");

const adapter = await navigator.gpu.requestAdapter();
const device = await adapter?.requestDevice();

if(!device)
	throw new Error("Failed to initialize GPUDevice");

const MGS = await MGSModule();

//-------------------------//

export class SplatPlayer extends HTMLElement 
{
	constructor() 
	{
		super();

		this.#canvas = document.createElement('canvas');
		this.#canvas.style.width = '100%';
		this.#canvas.style.height = '100%';
		this.#canvas.style.display = 'block';
		this.attachShadow({ mode: 'open' }).appendChild(this.#canvas);

	}

	async connectedCallback() 
	{
		//handle window resize:
		//---------------
		let onResize = () => {
			this.#canvas.width  = this.clientWidth  * CANVAS_RESOLUTION_SCALE;
			this.#canvas.height = this.clientHeight * CANVAS_RESOLUTION_SCALE;
		};

		onResize();
		window.addEventListener('resize', onResize);

		//create resources:
		//---------------
		this.#context = this.#createContext();
		this.#gaussianPipeline = this.#createGaussianPipeline();
		this.#geomBufs = this.#createGeometryBuffers();
		this.#paramsBuf = this.#createParamsBuffer();

		// this.#gaussians = this.#createGaussians(); //TEMP!

		//input handlers:
		//---------------
		window.addEventListener('keydown', (e) => { this.#keys[e.code] = true;  });
		window.addEventListener('keyup',   (e) => { this.#keys[e.code] = false; });

		this.#canvas.addEventListener('mousedown', (e) => {
			this.#isDragging = true;
			this.#lastMouse = [e.clientX, e.clientY];
		});
		window.addEventListener('mouseup', () => { this.#isDragging = false; });
		window.addEventListener('mousemove', (e) => {
			if(this.#isDragging) {
				const dx = e.clientX - this.#lastMouse[0];
				const dy = e.clientY - this.#lastMouse[1];
				this.#lastMouse = [e.clientX, e.clientY];

				const sensitivity = 0.0025;
				this.#camYaw   -= dx * sensitivity;
				this.#camPitch -= dy * sensitivity;
				this.#camPitch = Math.max(-Math.PI/2+0.01, Math.min(Math.PI/2-0.01, this.#camPitch));
			}
		});

		//initialize gaussians:
		//---------------
		const fetchResponse = await fetch('point_cloud.ply'); //TODO: dont hardcode this!
		if(!fetchResponse.ok)
			throw new Error("Failed to fetch test .ply");

		const plyBuf = await fetchResponse.arrayBuffer()

		const loadStartTime = performance.now();

		this.#gaussians = MGS.loadPlyPacked(plyBuf)
		this.#gaussianIndices = this.#gaussians.sortedIndices(this.#camPos[0], this.#camPos[1], this.#camPos[2]);

		const loadEndTime = performance.now();
		console.log(`PLY loading took ${loadEndTime - loadStartTime}ms`);

		const uploadStartTime = performance.now();

		this.#uploadGaussians();
		this.#uploadGaussianIndices();

		const uploadEndTime = performance.now();
		console.log(`GPU upload took ${uploadEndTime - uploadStartTime}ms`);

		//begin rendering:
		//---------------
		requestAnimationFrame((t) => {
			this.#render(t)
		});
	}

	//-------------------------//

	#canvas = null;
	#context = null;
	#gaussianPipeline = null;
	#geomBufs = null;
	#paramsBuf = null;

	#gaussians = null;
	#gaussianIndices = null;

	#gaussianBuf = null;
	#gaussianIndexBuf = null;

	#lastRenderTime = null;

	//TEMP:
	#camPos   = vec3.fromValues(3, 3, 3);
	#lastCamPos = vec3.copy(vec3.create(), this.#camPos);
	#camYaw   = -3 * Math.PI / 4;
	#camPitch = -Math.PI / 4;
	#keys     = {};
	#isDragging = false;
	#lastMouse = [0, 0];

	#sorting = false;
	#startSortingTime = 0.0;

	//-------------------------//

	#createContext()
	{
		const context = this.#canvas.getContext('webgpu');
		context.configure({
			device: device,
			format: navigator.gpu.getPreferredCanvasFormat(),
			alphaMode: 'opaque'
		});

		return context;
	}

	#createGaussianPipeline() 
	{
		const shaderModule = device.createShaderModule({
			label: 'gaussian',

			code: shaderCode 
		});

		const pipeline = device.createRenderPipeline({
			label: 'gaussian',

			layout: 'auto',
			vertex: {
				module: shaderModule,
				entryPoint: 'vs_main',
				buffers: [
					{
						stepMode: 'vertex',
						arrayStride: 2 * SIZEOF_FLOAT32,
						attributes: [{ 
							shaderLocation: 0, offset: 0, format: 'float32x2' //position
						}]
					},
					{
						stepMode: 'instance',
						arrayStride: SIZEOF_UINT32,
						attributes: [{
							shaderLocation: 1, offset: 0, format: 'uint32' //gaussian index
						}]
					}
				]
			},
			fragment: {
				module: shaderModule,
				entryPoint: 'fs_main',
				targets: [{ 
					format: navigator.gpu.getPreferredCanvasFormat(),
					blend: {
						alpha: { srcFactor: "one-minus-dst-alpha", dstFactor: "one", operation: "add" },
						color: { srcFactor: "one-minus-dst-alpha", dstFactor: "one", operation: "add" }
					}
				}]
			},
			primitive: { 
				topology: 'triangle-list', 
				cullMode: 'none' 
			}
		});

		return pipeline;
	}

	#createGeometryBuffers() 
	{
		//create vertex buffer:
		//---------------
		const quadVertices = new Float32Array([
			-2.0, -2.0,
			 2.0, -2.0,
			 2.0,  2.0,
			-2.0,  2.0
		]);
		const vertexBuffer = device.createBuffer({
			label: 'quad vertices',

			size: quadVertices.byteLength,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
		});
		device.queue.writeBuffer(vertexBuffer, 0, quadVertices);

		//create index buffer:
		//---------------
		const quadIndices = new Uint16Array([
			0, 1, 2, 
			0, 2, 3
		]);
		const indexBuffer = device.createBuffer({
			label: 'quad indices',

			size: quadIndices.byteLength,
			usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
		});
		device.queue.writeBuffer(indexBuffer, 0, quadIndices);

		//return:
		//---------------
		return {
			vertex: vertexBuffer,
			index: indexBuffer
		};
	}

	#createParamsBuffer()
	{
		let size = 0;
		size += 4 * 4 * SIZEOF_FLOAT32; // view
		size += 4 * 4 * SIZEOF_FLOAT32; // proj
		size += 2 * SIZEOF_FLOAT32;     // focal lengths
		size += 2 * SIZEOF_FLOAT32;     // viewport

		return device.createBuffer({
			label: 'params',

			size: size,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
	}

	#updateParamsBuffer(view, proj, focalLengths, viewPort)
	{
		const data = new Float32Array(this.#paramsBuf.size / SIZEOF_FLOAT32);
		let offset = 0;

		data.set(view, offset);
		offset += 4 * 4;

		data.set(proj, offset);
		offset += 4 * 4;

		data.set(focalLengths, offset);
		offset += 2;

		data.set(viewPort, offset);
		offset += 2;

		device.queue.writeBuffer(this.#paramsBuf, 0, data);
	}

	#createBindGroups()
	{
		const gaussianGroup = device.createBindGroup({
			label: 'gaussian',

			layout: this.#gaussianPipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: this.#paramsBuf } },
				{ binding: 1, resource: { buffer: this.#gaussianBuf } } //TEMP!!
			]
		});

		return {
			gaussian: gaussianGroup
		};
	}

	#updateCamera(dt)
	{
		const speed = 2.5 * dt;
		const forward = vec3.fromValues(
			Math.cos(this.#camPitch) * Math.sin(this.#camYaw),
			Math.sin(this.#camPitch),
			Math.cos(this.#camPitch) * Math.cos(this.#camYaw)
		);
		const right = vec3.fromValues(
			Math.sin(this.#camYaw - Math.PI/2),
			0,
			Math.cos(this.#camYaw - Math.PI/2)
		);

		if(this.#keys["KeyW"]) vec3.scaleAndAdd(this.#camPos, this.#camPos, forward, speed);
		if(this.#keys["KeyS"]) vec3.scaleAndAdd(this.#camPos, this.#camPos, forward, -speed);
		if(this.#keys["KeyA"]) vec3.scaleAndAdd(this.#camPos, this.#camPos, right, -speed);
		if(this.#keys["KeyD"]) vec3.scaleAndAdd(this.#camPos, this.#camPos, right, speed);
		if(this.#keys["Space"])     this.#camPos[1] += speed;
		if(this.#keys["ShiftLeft"]) this.#camPos[1] -= speed;
	}


	#render(timestamp)
	{
		//update camera:
		//---------------
		var dt = 0.0;
		if(this.#lastRenderTime)
			dt = timestamp - this.#lastRenderTime;

		this.#lastRenderTime = timestamp;
		this.#updateCamera(dt / 1000.0);

		//sort gaussians:
		//---------------

		//TEMP!!! figure out a better way to do this

		if(vec3.distance(this.#camPos, this.#lastCamPos) > 1.0 && !this.#sorting)
		{
			this.#gaussians.sortIndicesAsync(this.#camPos[0], this.#camPos[1], this.#camPos[2]);

			this.#sorting = true;
			this.#startSortingTime = performance.now();

			vec3.copy(this.#lastCamPos, this.#camPos);
		}

		if(this.#sorting)
		{
			let indices = this.#gaussians.sortIndicesAsyncRetrieve();

			if(indices)
			{
				this.#sorting = false;

				console.log(`gaussian sorting took ${performance.now() - this.#startSortingTime}ms`);

				this.#gaussianIndices.delete();
				this.#gaussianIndices = indices;
				this.#uploadGaussianIndices();
			}
		}

		//create cam/proj matrices:
		//---------------

		//TEMP!!! we want these supplied by user eventually!
		
		const target = vec3.create();
		target[0] = this.#camPos[0] + Math.cos(this.#camPitch) * Math.sin(this.#camYaw);
		target[1] = this.#camPos[1] + Math.sin(this.#camPitch);
		target[2] = this.#camPos[2] + Math.cos(this.#camPitch) * Math.cos(this.#camYaw);

		const view = mat4.create();
		this.lastView = view;
		mat4.lookAt(view, this.#camPos, target, [0,1,0]);

		const proj = mat4.create();
		const fovY = Math.PI / 4;
		const aspect = this.#canvas.width / this.#canvas.height;
		mat4.perspective(proj, fovY, aspect, 0.1, 100);

		const f = 1 / Math.tan(fovY / 2);
		const fx = f / aspect * (this.#canvas.width / 2);
		const fy = f * (this.#canvas.height / 2);

		const focalLengths = [fx, fy];
		const viewPort = [this.#canvas.width, this.#canvas.height];

		//update bufs + get bind groups:
		//---------------
		this.#updateParamsBuffer(view, proj, focalLengths, viewPort);
		const bindGroups = this.#createBindGroups();

		//render:
		//---------------
		const encoder = device.createCommandEncoder();
		const pass = encoder.beginRenderPass({
			label: 'main',

			colorAttachments: [{
				view: this.#context.getCurrentTexture().createView(),
				clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
				loadOp: 'clear',
				storeOp: 'store'
			}]
		});

		pass.setPipeline(this.#gaussianPipeline);
		pass.setVertexBuffer(0, this.#geomBufs.vertex);
		pass.setVertexBuffer(1, this.#gaussianIndexBuf);
		pass.setIndexBuffer(this.#geomBufs.index, 'uint16');
		pass.setBindGroup(0, bindGroups.gaussian);

		pass.drawIndexed(6, this.#gaussians.count());

		pass.end();
		device.queue.submit([encoder.finish()]);

		//loop:
		//---------------
		requestAnimationFrame((t) => {
			this.#render(t)
		});
	}

	#packGaussian(sigma, mean, color) 
	{
		let data = new ArrayBuffer(8 * 4);
		let dataUint  = new Uint32Array (data);
		let dataFloat = new Float32Array(data);

		function float32ToFloat16(val) 
		{
			const floatView = new Float32Array(1);
			const int32View = new Uint32Array(floatView.buffer);
			floatView[0] = val;
			const x = int32View[0];
			let bits = (x >> 16) & 0x8000; // sign
			let m = (x & 0x7fffff) >> 13;
			let e = ((x >> 23) & 0xff) - 127 + 15;
			if (e <= 0) { return bits; }
			if (e >= 31) { return bits | 0x7c00 | m; }

			return bits | (e << 10) | (m & 0x3ff);
		}

		function pack2x16half(f1, f2) 
		{
			return (float32ToFloat16(f2) << 16) | float32ToFloat16(f1);
		}

		dataUint.set([
			pack2x16half(4 * sigma[0], 4 * sigma[1]),
			pack2x16half(4 * sigma[2], 4 * sigma[3]),
			pack2x16half(4 * sigma[4], 4 * sigma[5])
		], 0); //covariance

		const colorU32 = (
			(color[3] * 255) << 24 |
			(color[2] * 255) << 16 |
			(color[1] * 255) << 8  |
			(color[0] * 255)
		) >>> 0;
		dataUint.set(
			[colorU32],
			3
		); //color

		dataFloat.set(
			mean, 
			4
		); //mean

		return data;
	}


	// ------ TEMP -------

	#createGaussians()
	{
		return [
			this.#packGaussian(
				mat3.identity(mat3.create()),
				vec3.fromValues(0.75, 0.0, 0.0),
				vec4.fromValues(1.0, 0.0, 0.0, 0.5)
			),
			this.#packGaussian(
				mat3.identity(mat3.create()),
				vec3.fromValues(-0.75, 0.0, 0.0),
				vec4.fromValues(0.0, 0.0, 1.0, 0.5)
			),
			this.#packGaussian(
				mat3.identity(mat3.create()),
				vec3.fromValues(0.0, 0.0, 0.75),
				vec4.fromValues(0.0, 1.0, 0.0, 0.5)
			),
			this.#packGaussian(
				mat3.identity(mat3.create()),
				vec3.fromValues(0.0, 0.0, -0.75),
				vec4.fromValues(1.0, 1.0, 0.0, 0.5)
			)
		];
	}

	#sortGaussians(view, gaussians)
	{
		const camPos = vec4.transformMat4(vec4.create(), vec4.fromValues(0.0, 0.0, 0.0, 1.0), mat4.invert(mat4.create(), view));

		let keys = [];
		for(let i = 0; i < gaussians.length; i++)
		{
			let floats = new Float32Array(gaussians[i]);
			let mean = vec3.fromValues(floats[4], floats[5], floats[6]);
			let to = vec3.sub(vec3.create(), camPos, mean);

			keys.push({
				dist: vec3.squaredLength(to),
				gaussian: gaussians[i]
			});
		}

		keys.sort((a, b) => a.dist - b.dist);
		return keys.map((k) => k.gaussian);
	}

	#uploadGaussians()
	{
		const gaussianSize = 8 * SIZEOF_FLOAT32;
		this.#gaussianBuf = device.createBuffer({
			label: 'gaussians',

			size: this.#gaussians.count() * gaussianSize,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		});

		device.queue.writeBuffer(this.#gaussianBuf, 0, this.#gaussians.getBuffer());
	}

	#uploadGaussianIndices()
	{
		this.#gaussianIndexBuf = device.createBuffer({
			label: 'gaussian indices',

			size: this.#gaussians.count() * SIZEOF_UINT32,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
		});

		device.queue.writeBuffer(this.#gaussianIndexBuf, 0, this.#gaussianIndices.getBuffer());
	}


#processPlyBuffer(inputBuffer) {
        const ubuf = new Uint8Array(inputBuffer);
        // 10KB ought to be enough for a header...
        const header = new TextDecoder().decode(ubuf.slice(0, 1024 * 10));
        const header_end = "end_header\n";
        const header_end_index = header.indexOf(header_end);
        if (header_end_index < 0)
            throw new Error("Unable to read .ply file header");
        const vertexCount = parseInt(/element vertex (\d+)\n/.exec(header)[1]);
        console.log("Vertex Count", vertexCount);
        let row_offset = 0,
            offsets = {},
            types = {};
        const TYPE_MAP = {
            double: "getFloat64",
            int: "getInt32",
            uint: "getUint32",
            float: "getFloat32",
            short: "getInt16",
            ushort: "getUint16",
            uchar: "getUint8",
        };
        for (let prop of header
            .slice(0, header_end_index)
            .split("\n")
            .filter((k) => k.startsWith("property "))) {
            const [p, type, name] = prop.split(" ");
            const arrayType = TYPE_MAP[type] || "getInt8";
            types[name] = arrayType;
            offsets[name] = row_offset;
            row_offset += parseInt(arrayType.replace(/[^\d]/g, "")) / 8;
        }
        console.log("Bytes per row", row_offset, types, offsets);

        let dataView = new DataView(
            inputBuffer,
            header_end_index + header_end.length,
        );
        let row = 0;
        const attrs = new Proxy(
            {},
            {
                get(target, prop) {
                    if (!types[prop]) throw new Error(prop + " not found");
                    return dataView[types[prop]](
                        row * row_offset + offsets[prop],
                        true,
                    );
                },
            },
        );

        // 6*4 + 4 + 4 = 8*4
        // XYZ - Position (Float32)
        // XYZ - Scale (Float32)
        // RGBA - colors (uint8)
        // IJKL - quaternion/rot (uint8)
        const rowLength = 3 * 4 + 3 * 4 + 4 + 4;

		let result = [];

        console.time("build buffer");
        for (let j = 0; j < vertexCount; j++) {
            row = j;

            const position = new Float32Array(3);
            const scales = new Float32Array(3);
            const rgba = new Uint8ClampedArray(4);
            let rot = new Float32Array(4);

            if (types["scale_0"]) {
                const qlen = Math.sqrt(
                    attrs.rot_0 ** 2 +
                        attrs.rot_1 ** 2 +
                        attrs.rot_2 ** 2 +
                        attrs.rot_3 ** 2,
                );

                rot[0] = (attrs.rot_0 / qlen);
                rot[1] = (attrs.rot_1 / qlen);
                rot[2] = (attrs.rot_2 / qlen);
                rot[3] = (attrs.rot_3 / qlen);

                scales[0] = Math.exp(attrs.scale_0);
                scales[1] = Math.exp(attrs.scale_1);
                scales[2] = Math.exp(attrs.scale_2);
            } else {
                scales[0] = 0.01;
                scales[1] = 0.01;
                scales[2] = 0.01;

                rot[0] = 1.0;
                rot[1] = 0;
                rot[2] = 0;
                rot[3] = 0;
            }

            position[0] = attrs.x;
            position[1] = attrs.y;
            position[2] = attrs.z;

            if (types["f_dc_0"]) {
                const SH_C0 = 0.28209479177387814;
                rgba[0] = (0.5 + SH_C0 * attrs.f_dc_0) * 255;
                rgba[1] = (0.5 + SH_C0 * attrs.f_dc_1) * 255;
                rgba[2] = (0.5 + SH_C0 * attrs.f_dc_2) * 255;
            } else {
                rgba[0] = attrs.red;
                rgba[1] = attrs.green;
                rgba[2] = attrs.blue;
            }
            if (types["opacity"]) {
                rgba[3] = (1 / (1 + Math.exp(-attrs.opacity))) * 255;
            } else {
                rgba[3] = 255;
            }

			const M = [
                1.0 - 2.0 * (rot[2] * rot[2] + rot[3] * rot[3]),
                2.0 * (rot[1] * rot[2] + rot[0] * rot[3]),
                2.0 * (rot[1] * rot[3] - rot[0] * rot[2]),

                2.0 * (rot[1] * rot[2] - rot[0] * rot[3]),
                1.0 - 2.0 * (rot[1] * rot[1] + rot[3] * rot[3]),
                2.0 * (rot[2] * rot[3] + rot[0] * rot[1]),

                2.0 * (rot[1] * rot[3] + rot[0] * rot[2]),
                2.0 * (rot[2] * rot[3] - rot[0] * rot[1]),
                1.0 - 2.0 * (rot[1] * rot[1] + rot[2] * rot[2]),
            ].map((k, i) => k * scales[Math.floor(i / 3)]);

            const sigma = [
                M[0] * M[0] + M[3] * M[3] + M[6] * M[6],
                M[0] * M[1] + M[3] * M[4] + M[6] * M[7],
                M[0] * M[2] + M[3] * M[5] + M[6] * M[8],
                M[1] * M[1] + M[4] * M[4] + M[7] * M[7],
                M[1] * M[2] + M[4] * M[5] + M[7] * M[8],
                M[2] * M[2] + M[5] * M[5] + M[8] * M[8],
            ];

			if(j == 0)
			{
				console.log('JS SIGMA:');
				console.log(sigma);
			}
			// const cov = [
			// 	sigma[0] * 4, sigma[1] * 4, sigma[2] * 4,
			// 	sigma[1] * 4, sigma[3] * 4, sigma[4] * 4,
			// 	sigma[2] * 4, sigma[4] * 4, sigma[5] * 4
			// ];

			result.push(this.#packGaussian(sigma, position, new Float32Array([rgba[0] / 255.0, rgba[1] / 255.0, rgba[2] / 255.0, rgba[3] / 255.0]), j == 0))
        }
        console.timeEnd("build buffer");
        return result;
    }

}

customElements.define('splat-player', SplatPlayer);
