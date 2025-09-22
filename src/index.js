/* index.js
 * 
 * contains the core logic
 */

const CANVAS_RESOLUTION_SCALE = 2;

const SIZEOF_FLOAT32 = Float32Array.BYTES_PER_ELEMENT;
const SIZEOF_UINT32  = Uint32Array.BYTES_PER_ELEMENT;

//-------------------------//

import { mat3, mat4, vec3, vec4 } from 'gl-matrix';
import shaderCode from './shaders/gaussian.wgsl?raw';

//-------------------------//

if(!navigator.gpu) 
	throw new Error("WebGPU isn not supported!");

const adapter = await navigator.gpu.requestAdapter();
const device = await adapter?.requestDevice();

if(!device)
	throw new Error("Failed to initialize GPUDevice");

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

	connectedCallback() 
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

		this.#gaussians = this.#createGaussians(); //TEMP!

		//input handlers:
		//---------------
		window.addEventListener('keydown', (e) => { this.#keys[e.code] = true; });
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

	#lastRenderTime = null;

	//TEMP:
	#gaussians = null;
	#gaussianBuf = null;
	#camPos   = vec3.fromValues(3, 3, 3);
	#camYaw   = -3 * Math.PI / 4;
	#camPitch = -Math.PI / 4;
	#keys     = {};
	#isDragging = false;
	#lastMouse = [0, 0];

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
				buffers: [{
					arrayStride: 2 * SIZEOF_FLOAT32,
					attributes: [{ 
						shaderLocation: 0, offset: 0, format: 'float32x2' //position
					}]
				}]
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

		//create cam/proj matrices:
		//---------------

		//TEMP!!! we want these supplied by user eventually!
		
		const target = vec3.create();
		target[0] = this.#camPos[0] + Math.cos(this.#camPitch) * Math.sin(this.#camYaw);
		target[1] = this.#camPos[1] + Math.sin(this.#camPitch);
		target[2] = this.#camPos[2] + Math.cos(this.#camPitch) * Math.cos(this.#camYaw);

		const view = mat4.create();
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

		//sort gaussians:
		//---------------
		const gaussians = this.#sortGaussians(view, this.#gaussians);
		this.#uploadGaussians(gaussians);

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
		pass.setIndexBuffer(this.#geomBufs.index, 'uint16');
		pass.setBindGroup(0, bindGroups.gaussian);

		const pointCount = 4;
		pass.drawIndexed(6, pointCount); //TEMP!

		pass.end();
		device.queue.submit([encoder.finish()]);

		//loop:
		//---------------
		requestAnimationFrame((t) => {
			this.#render(t)
		});
	}

	#packGaussian(cov, mean, color) 
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
			pack2x16half(cov[0], cov[1]),
			pack2x16half(cov[2], cov[4]),
			pack2x16half(cov[5], cov[8])
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

	#uploadGaussians(gaussians)
	{
		const gaussianSize = 8 * SIZEOF_FLOAT32;

		this.#gaussianBuf = device.createBuffer({
			size: gaussians.length * gaussianSize,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		});

		for(let i = 0; i < gaussians.length; i++)
			device.queue.writeBuffer(this.#gaussianBuf, i * gaussianSize, gaussians[i]);
	}
}

customElements.define('splat-player', SplatPlayer);
