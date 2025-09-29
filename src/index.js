/* index.js
 * 
 * contains the core logic
 */

const CANVAS_RESOLUTION_SCALE = 2;

const SIZEOF_FLOAT32 = Float32Array.BYTES_PER_ELEMENT;
const SIZEOF_UINT32  = Uint32Array.BYTES_PER_ELEMENT;

const RENDERER_PROFILING = true;

const PLY_PATH = "output.ply";

const SORT_DISTANCE_CUTOFF = 0.1;
const CAMERA_SPEED = 0.1;

//-------------------------//

import { mat3, mat4, vec3, vec4 } from 'gl-matrix';
import MGSModule from './wasm/mgs.js'
import shaderCode from './shaders/gaussian.wgsl?raw';

//-------------------------//

if(!navigator.gpu) 
	throw new Error("WebGPU isn not supported!");

const adapter = await navigator.gpu.requestAdapter();
const device = await adapter?.requestDevice(RENDERER_PROFILING ? { requiredFeatures: ['timestamp-query'] } : null);

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

		if(RENDERER_PROFILING)
			this.#profiler = this.#createProfiler();

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
				this.#camYaw   += dx * sensitivity;
				this.#camPitch += dy * sensitivity;
				this.#camPitch = Math.max(-Math.PI/2+0.01, Math.min(Math.PI/2-0.01, this.#camPitch));
			}
		});

		//initialize gaussians:
		//---------------
		const fetchResponse = await fetch(PLY_PATH);
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
	#profiler = null;

	#gaussians = null;
	#gaussianIndices = null;

	#gaussianBuf = null;
	#gaussianIndexBuf = null;

	#lastRenderTime = null;

	#camPos     = vec3.zero(vec3.create());
	#lastCamPos = vec3.copy(vec3.create(), this.#camPos);
	#camYaw   = 0.0;
	#camPitch = 0.0;
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

	#createProfiler()
	{
		const querySet = device.createQuerySet({
			type: 'timestamp',
			count: 4
		});

		return {
			querySet: querySet,
			accumFrames: 0,
			accumTime: 0.0,
			accumRasterTime: 0,
			accumPreprocessTime: 0
		};
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
		const speed = dt * CAMERA_SPEED;
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
		if(this.#keys["KeyA"]) vec3.scaleAndAdd(this.#camPos, this.#camPos, right, speed);
		if(this.#keys["KeyD"]) vec3.scaleAndAdd(this.#camPos, this.#camPos, right, -speed);
		if(this.#keys["Space"])     this.#camPos[1] -= speed;
		if(this.#keys["ShiftLeft"]) this.#camPos[1] += speed;
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

		if(vec3.distance(this.#camPos, this.#lastCamPos) > SORT_DISTANCE_CUTOFF)
		{
			this.#gaussianIndices.delete();

			const start = performance.now();

			this.#gaussianIndices = this.#gaussians.sortedIndices(this.#camPos[0], this.#camPos[1], this.#camPos[2]);
			this.#uploadGaussianIndices();

			const end = performance.now();

			console.log(`gaussian sorting took ${end - start}ms`);

			vec3.copy(this.#lastCamPos, this.#camPos);
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
		mat4.lookAt(view, this.#camPos, target, [0, 1, 0]);

		const proj = mat4.create();
		const fovY = Math.PI / 4;
		const aspect = this.#canvas.width / this.#canvas.height;
		mat4.perspective(proj, fovY, aspect, 0.01, 100);

		const f = 1 / Math.tan(fovY / 2);
		const fx = f / aspect * (this.#canvas.width / 2);
		const fy = f * (this.#canvas.height / 2);

		const focalLengths = [fx, fy];
		const viewPort = [this.#canvas.width, this.#canvas.height];

		//update bufs + get bind groups:
		//---------------
		this.#updateParamsBuffer(view, proj, focalLengths, viewPort);
		const bindGroups = this.#createBindGroups();

		//create query buffers:
		//-----------------
		let queryBuffer = null;
		let queryReadbackBuffer = null;
		if(RENDERER_PROFILING)
		{
			queryBuffer = device.createBuffer({
				size: 4 * 8,
				usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
			});

			queryReadbackBuffer = device.createBuffer({
				size: 4 * 8,
				usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
			});
		}

		//create command encoder:
		//---------------
		const encoder = device.createCommandEncoder();

		//rasterize:
		//---------------
		const pass = encoder.beginRenderPass({
			label: 'main',

			colorAttachments: [{
				view: this.#context.getCurrentTexture().createView(),
				clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
				loadOp: 'clear',
				storeOp: 'store'
			}],

			timestampWrites: RENDERER_PROFILING ? {
				querySet: this.#profiler.querySet,
				beginningOfPassWriteIndex: 2,
				endOfPassWriteIndex: 3
			} : undefined
		});

		pass.setPipeline(this.#gaussianPipeline);
		pass.setVertexBuffer(0, this.#geomBufs.vertex);
		pass.setVertexBuffer(1, this.#gaussianIndexBuf);
		pass.setIndexBuffer(this.#geomBufs.index, 'uint16');
		pass.setBindGroup(0, bindGroups.gaussian);

		pass.drawIndexed(6, this.#gaussians.count());

		pass.end();

		//submit command buffer:
		//---------------
		if(RENDERER_PROFILING)
		{
			encoder.resolveQuerySet(this.#profiler.querySet, 0, 4, queryBuffer, 0);
			encoder.copyBufferToBuffer(queryBuffer, 0, queryReadbackBuffer, 0, 4 * 8);
		}

		device.queue.submit([encoder.finish()]);

		//read profiling data:
		//-----------------
		if(RENDERER_PROFILING)
		{
			queryReadbackBuffer.mapAsync(GPUMapMode.READ).then(() => {
				const timestampsBuf = queryReadbackBuffer.getMappedRange();
				const timestamps = new BigUint64Array(timestampsBuf);

				this.#profiler.accumFrames++;
				this.#profiler.accumTime += dt;
				this.#profiler.accumPreprocessTime += 0; //TODO
				this.#profiler.accumRasterTime     += Number(timestamps[3] - timestamps[2]);

				queryReadbackBuffer.unmap();

				if(this.#profiler.accumTime >= 1000.0)
				{
					const avgPreprocessTime = (this.#profiler.accumPreprocessTime / 1000000) / this.#profiler.accumFrames;
					const avgRasterTime     = (this.#profiler.accumRasterTime     / 1000000) / this.#profiler.accumFrames;
					const avgTime = avgPreprocessTime + avgRasterTime;

					const lines = [
						`GPU time: ${avgTime.toPrecision(3)}ms/frame`,
						`  - ${avgPreprocessTime.toPrecision(3)}ms preprocessing`,
						`  - ${avgRasterTime.toPrecision(3)}ms rasterizing`,
					];
					console.log(lines.join('\n'));

					this.#profiler.accumFrames = 0;
					this.#profiler.accumTime = 0.0;
					this.#profiler.accumPreprocessTime = 0;
					this.#profiler.accumRasterTime = 0;
				}
			});
		}

		//loop:
		//---------------
		requestAnimationFrame((t) => {
			this.#render(t)
		});
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
}

customElements.define('splat-player', SplatPlayer);
