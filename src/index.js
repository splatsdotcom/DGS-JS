/* index.js
 * 
 * contains the core logic
 */

const CANVAS_RESOLUTION_SCALE = 2;

const SIZEOF_FLOAT32 = Float32Array.BYTES_PER_ELEMENT;
const SIZEOF_UINT32  = Uint32Array.BYTES_PER_ELEMENT;

const GAUSSIAN_PREPROCESS_WORKGROUP_SIZE = 64;
const RENDERER_NUM_TIMESTAMP_QUERIES = 6;

//TEMP
const PLY_PATH = "output.ply";
const CAMERA_SPEED = 0.1;

//-------------------------//

import MGSModule from './wasm/mgs.js'
const MGS = await MGSModule();

import { mat4, vec3 } from 'gl-matrix';
import { GPU_PROFILING, device } from './renderer/context.js';
import RadixSortKernel from './renderer/radix_sort_kernel.js';

import GAUSSIAN_PREPROCESS_SHADER_SRC from './renderer/shaders/gaussian_preprocess.wgsl?raw';
import GAUSSIAN_RASTERIZE_SHADER_SRC  from './renderer/shaders/gaussian_rasterize.wgsl?raw';

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
		this.#preprocessPipeline = this.#createPreprocessPipeline();
		this.#rasterizePipeline = this.#createRasterizePipeline();
		this.#geomBufs = this.#createGeometryBuffers();
		this.#paramsBuf = this.#createParamsBuffer();

		if(GPU_PROFILING)
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

		this.#gaussians = MGS.loadPly(plyBuf)

		const loadEndTime = performance.now();
		console.log(`PLY loading took ${loadEndTime - loadStartTime}ms`);

		const uploadStartTime = performance.now();

		this.#gaussianBufs = this.#createGaussianBufs(this.#gaussians);

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
	#preprocessPipeline = null;
	#rasterizePipeline = null;
	#profiler = null;

	#gaussians = null;
	#gaussianBufs = null;
	#geomBufs = null;
	#paramsBuf = null;

	#lastRenderTime = null;

	#camPos     = vec3.zero(vec3.create());
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

	#createPreprocessPipeline()
	{
		const shaderModule = device.createShaderModule({
			label: 'gaussian preprocess',

			code: GAUSSIAN_PREPROCESS_SHADER_SRC,
		});

		return device.createComputePipeline({
			label: 'gaussian preprocess',

			layout: 'auto',
			compute: {
				module: shaderModule,
				entryPoint: 'preprocess',
				constants: {
					'WORKGROUP_SIZE': GAUSSIAN_PREPROCESS_WORKGROUP_SIZE,
				}
			}
		});
	}

	#createRasterizePipeline() 
	{
		const shaderModule = device.createShaderModule({
			label: 'gaussian rasterize',

			code: GAUSSIAN_RASTERIZE_SHADER_SRC 
		});

		const pipeline = device.createRenderPipeline({
			label: 'gaussian',

			layout: 'auto',
			vertex: {
				module: shaderModule,
				entryPoint: 'vs',
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
							shaderLocation: 1, offset: 0, format: 'uint32' //index
						}]
					}
				]
			},
			fragment: {
				module: shaderModule,
				entryPoint: 'fs',
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

	#createProfiler()
	{
		const querySet = device.createQuerySet({
			type: 'timestamp',
			count: RENDERER_NUM_TIMESTAMP_QUERIES
		});

		return {
			querySet: querySet,
			accumFrames: 0,
			accumTime: 0,
			accumRasterTime: 0,
			accumSortTime: 0,
			accumPreprocessTime: 0
		};
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
		size += 3 * SIZEOF_FLOAT32;     // cam pos
		size += 1 * SIZEOF_UINT32;      // sh degree
		size += 2 * SIZEOF_FLOAT32;     // focal lengths
		size += 2 * SIZEOF_FLOAT32;     // viewport

		return device.createBuffer({
			label: 'params',

			size: size,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
	}

	#createGaussianBufs(gaussians)
	{
		const renderedGaussianSize = 12 * SIZEOF_FLOAT32;
		const renderedGaussianHeaderSize = 8 * SIZEOF_UINT32;

		const gaussianBuf = device.createBuffer({
			label: 'gaussians',

			size: gaussians.buffer.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		});
		device.queue.writeBuffer(gaussianBuf, 0, gaussians.buffer);

		const renderedGaussianBuf = device.createBuffer({
			label: 'rendered gaussians',

			size: renderedGaussianHeaderSize + gaussians.length * renderedGaussianSize,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.INDIRECT
		});

		const gaussianDepthBuf = device.createBuffer({
			label: 'gaussian depths',

			size: gaussians.length * SIZEOF_UINT32,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		});

		const gaussianIndexBuf = device.createBuffer({
			label: 'gaussian indices',

			size: gaussians.length * SIZEOF_UINT32,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX
		});

		return {
			gaussians: gaussianBuf,
			rendered: renderedGaussianBuf,
			depths: gaussianDepthBuf,
			indices: gaussianIndexBuf
		};
	}

	#updateParamsBuffer(view, proj, camPos, focalLengths, viewPort)
	{
		const data = new ArrayBuffer(this.#paramsBuf.size);
		const fData = new Float32Array(data);
		const uData = new Uint32Array(data);

		let offset = 0;

		fData.set(view, offset);
		offset += 4 * 4;

		fData.set(proj, offset);
		offset += 4 * 4;

		fData.set(camPos, offset);
		offset += 3;

		uData.set([this.#gaussians.shDegree], offset);
		offset += 1;

		fData.set(focalLengths, offset);
		offset += 2;

		fData.set(viewPort, offset);
		offset += 2;

		device.queue.writeBuffer(this.#paramsBuf, 0, data);
	}

	#createBindGroups()
	{
		const preprocessGroup = device.createBindGroup({
			label: 'gaussian preprocess',

			layout: this.#preprocessPipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: this.#paramsBuf } },
				{ binding: 1, resource: { buffer: this.#gaussianBufs.gaussians } },

				{ binding: 2, resource: { buffer: this.#gaussianBufs.rendered } },
				{ binding: 3, resource: { buffer: this.#gaussianBufs.depths } },
				{ binding: 4, resource: { buffer: this.#gaussianBufs.indices } }
			]
		});

		const rasterizeGroup = device.createBindGroup({
			label: 'gaussian rasterize',

			layout: this.#rasterizePipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: this.#paramsBuf } },
				{ binding: 1, resource: { buffer: this.#gaussianBufs.rendered } }
			]
		});

		return {
			preprocess: preprocessGroup,
			rasterize: rasterizeGroup
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

		//create cam/proj matrices:
		//---------------

		//TEMP!!! we want these supplied by user eventually!
		
		const target = vec3.create();
		target[0] = this.#camPos[0] + Math.cos(this.#camPitch) * Math.sin(this.#camYaw);
		target[1] = this.#camPos[1] + Math.sin(this.#camPitch);
		target[2] = this.#camPos[2] + Math.cos(this.#camPitch) * Math.cos(this.#camYaw);

		const view = mat4.create();
		this.lastView = view;
		mat4.lookAt(view, this.#camPos, target, [0, -1, 0]);

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
		this.#updateParamsBuffer(view, proj, this.#camPos, focalLengths, viewPort);
		const bindGroups = this.#createBindGroups();

		//create query buffers:
		//-----------------
		let queryBuffer = null;
		let queryReadbackBuffer = null;
		if(GPU_PROFILING)
		{
			queryBuffer = device.createBuffer({
				size: RENDERER_NUM_TIMESTAMP_QUERIES * 8,
				usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
			});

			queryReadbackBuffer = device.createBuffer({
				size: RENDERER_NUM_TIMESTAMP_QUERIES * 8,
				usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
			});
		}

		//create command encoder:
		//---------------
		const encoder = device.createCommandEncoder();

		//preprocess:
		//---------------
		const renderedGaussianBufClearValue = new Uint32Array([
			6, //index count
			0, //instance count (incremented in shader)
			0, //first index
			0, //base vertex
			0  //first instance
		]);
		device.queue.writeBuffer(this.#gaussianBufs.rendered, 0, renderedGaussianBufClearValue);

		const gaussianDepthClearValue = new Uint32Array(this.#gaussians.length).fill(0xFFFFFFFF);
		device.queue.writeBuffer(this.#gaussianBufs.depths, 0, gaussianDepthClearValue); //TODO: please dont do this

		const preprocessPass = encoder.beginComputePass({
			timestampWrites: GPU_PROFILING ? {
				querySet: this.#profiler.querySet,
				beginningOfPassWriteIndex: 0,
				endOfPassWriteIndex: 1
			} : undefined
		});

		preprocessPass.setPipeline(this.#preprocessPipeline);
		preprocessPass.setBindGroup(0, bindGroups.preprocess);

		preprocessPass.dispatchWorkgroups(Math.ceil(this.#gaussians.length / GAUSSIAN_PREPROCESS_WORKGROUP_SIZE));

		preprocessPass.end();

		//sort by distance:
		//---------------
		const sortPass = encoder.beginComputePass({
			timestampWrites: GPU_PROFILING ? {
				querySet: this.#profiler.querySet,
				beginningOfPassWriteIndex: 2,
				endOfPassWriteIndex: 3
			} : undefined
		});

		//TODO: actually read number of rendered gaussians!!!!
		const sort = new RadixSortKernel(this.#gaussians.length, this.#gaussianBufs.depths, this.#gaussianBufs.indices, 32);
		sort.dispatch(sortPass);

		sortPass.end();

		//rasterize:
		//---------------
		const rasterPass = encoder.beginRenderPass({
			label: 'main',

			colorAttachments: [{
				view: this.#context.getCurrentTexture().createView(),
				clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
				loadOp: 'clear',
				storeOp: 'store'
			}],

			timestampWrites: GPU_PROFILING ? {
				querySet: this.#profiler.querySet,
				beginningOfPassWriteIndex: 4,
				endOfPassWriteIndex: 5
			} : undefined
		});

		rasterPass.setPipeline(this.#rasterizePipeline);
		rasterPass.setVertexBuffer(0, this.#geomBufs.vertex);
		rasterPass.setVertexBuffer(1, this.#gaussianBufs.indices);
		rasterPass.setIndexBuffer(this.#geomBufs.index, 'uint16');
		rasterPass.setBindGroup(0, bindGroups.rasterize);

		rasterPass.drawIndexedIndirect(this.#gaussianBufs.rendered, 0);

		rasterPass.end();

		//submit command buffer:
		//---------------
		if(GPU_PROFILING)
		{
			encoder.resolveQuerySet(this.#profiler.querySet, 0, RENDERER_NUM_TIMESTAMP_QUERIES, queryBuffer, 0);
			encoder.copyBufferToBuffer(queryBuffer, 0, queryReadbackBuffer, 0, RENDERER_NUM_TIMESTAMP_QUERIES * 8);
		}

		device.queue.submit([encoder.finish()]);

		//read profiling data:
		//-----------------
		if(GPU_PROFILING)
		{
			queryReadbackBuffer.mapAsync(GPUMapMode.READ).then(() => {
				const timestampsBuf = queryReadbackBuffer.getMappedRange();
				const timestamps = new BigUint64Array(timestampsBuf);

				this.#profiler.accumFrames++;
				this.#profiler.accumTime += dt;
				this.#profiler.accumPreprocessTime += Number(timestamps[1] - timestamps[0]);
				this.#profiler.accumSortTime       += Number(timestamps[3] - timestamps[2]);
				this.#profiler.accumRasterTime     += Number(timestamps[5] - timestamps[4]);

				queryReadbackBuffer.unmap();

				if(this.#profiler.accumTime >= 1000.0)
				{
					const avgPreprocessTime = (this.#profiler.accumPreprocessTime / 1000000) / this.#profiler.accumFrames;
					const avgSortTime       = (this.#profiler.accumSortTime       / 1000000) / this.#profiler.accumFrames;
					const avgRasterTime     = (this.#profiler.accumRasterTime     / 1000000) / this.#profiler.accumFrames;
					const avgTime = avgPreprocessTime + avgSortTime + avgRasterTime;

					const lines = [
						`GPU time: ${avgTime.toPrecision(3)}ms/frame`,
						`  - ${avgPreprocessTime.toPrecision(3)}ms preprocessing`,
						`  - ${avgSortTime.toPrecision(3)}ms sorting`,
						`  - ${avgRasterTime.toPrecision(3)}ms rasterizing`,
					];
					console.log(lines.join('\n'));

					this.#profiler.accumFrames = 0;
					this.#profiler.accumTime = 0.0;
					this.#profiler.accumPreprocessTime = 0;
					this.#profiler.accumSortTime = 0;
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
}

customElements.define('splat-player', SplatPlayer);
