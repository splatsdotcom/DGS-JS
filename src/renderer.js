/* renderer.js
 *
 * contains the implementation of the gaussian splat renderer
 */

const SIZEOF_FLOAT32 = Float32Array.BYTES_PER_ELEMENT;
const SIZEOF_UINT32  = Uint32Array.BYTES_PER_ELEMENT;

const GAUSSIAN_PREPROCESS_WORKGROUP_SIZE = 64;
const RENDERER_NUM_TIMESTAMP_QUERIES = 6;

//-------------------------//

import { mat4, vec3 } from 'gl-matrix';
import { GPU_PROFILING, device } from './context.js';
import RadixSortKernel from './radix_sort_kernel.js';

import GAUSSIAN_PREPROCESS_SHADER_SRC from './shaders/gaussian_preprocess.wgsl?raw';
import GAUSSIAN_RASTERIZE_SHADER_SRC  from './shaders/gaussian_rasterize.wgsl?raw';
import COMPOSITE_SHADER_SRC from './shaders/composite.wgsl?raw';

//-------------------------//

class Renderer
{
	constructor(canvas)
	{
		this.#canvas = canvas;

		this.#context = this.#createContext();
		this.#finalTex = this.#createFinalTex();
		this.#preprocessPipeline = this.#createPreprocessPipeline();
		this.#rasterizePipeline = this.#createRasterizePipeline();
		this.#compositePipeline = this.#createCompositePipeline();
		this.#geomBufs = this.#createGeometryBuffers();
		this.#paramsBuf = this.#createParamsBuffer();

		if(GPU_PROFILING)
			this.#profiler = this.#createProfiler();
	}

	resize()
	{
		this.#finalTex = this.#createFinalTex()
	}

	setGaussians(gaussians)
	{
		this.#gaussians = gaussians;
		this.#gaussianBufs = this.#createGaussianBufs(this.#gaussians);
	}

	setBackgroundColor(color)
	{
		this.#backgroundColor = color;
	}

	draw(view, proj, time)
	{
		if(!this.#gaussians)
			return;

		//get timing data:
		//-----------------
		let curRenderTime = performance.now();

		var dt = 0.0;
		if(this.#lastRenderTime)
			dt = curRenderTime - this.#lastRenderTime;

		this.#lastRenderTime = curRenderTime;

		//update bufs + get bind groups:
		//---------------
		const camPos = vec3.transformMat4(vec3.create(), vec3.fromValues(0.0, 0.0, 0.0), mat4.invert(mat4.create(), view));
		const focalLengths = [ proj[0] * (this.#canvas.width / 2), proj[5] * (this.#canvas.height / 2) ];
		const viewPort = [ this.#canvas.width, this.#canvas.height ];

		this.#updateParamsBuffer(view, proj, camPos, focalLengths, viewPort, time);
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
				view: this.#finalTex.view,
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

		//composite:
		//---------------
		const compositePass = encoder.beginRenderPass({
			label: 'composite',
			colorAttachments: [{
				view: this.#context.getCurrentTexture().createView(),
				clearValue: { r: this.#backgroundColor[0], g: this.#backgroundColor[1], b: this.#backgroundColor[2], a: 1.0 },
				loadOp: 'clear',
				storeOp: 'store'
			}]
		});

		compositePass.setPipeline(this.#compositePipeline);
		compositePass.setBindGroup(0, bindGroups.composite);
		compositePass.draw(3);
		compositePass.end();

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

				if(this.#profiler.accumTime >= 1.0)
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
	}

	//-------------------------//

	#canvas = null;
	#context = null;
	#finalTex = null;
	#preprocessPipeline = null;
	#rasterizePipeline = null;
	#compositePipeline = null;
	#profiler = null;

	#backgroundColor = [0.0, 0.0, 0.0];

	#gaussians = null;
	#gaussianBufs = null;
	#geomBufs = null;
	#paramsBuf = null;

	#lastRenderTime = null;

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

	#createFinalTex()
	{
		const width = this.#canvas.width | 0;
		const height = this.#canvas.height | 0;
		if(width == 0 || height == 0) 
			return;

		const format = navigator.gpu.getPreferredCanvasFormat();

		const tex = device.createTexture({
			size: [width, height, 1],
			format: format,
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
		});

		return {
			tex: tex,
			view: tex.createView(),
			sampler: device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
		}
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

	#createCompositePipeline()
	{
		const shaderModule = device.createShaderModule({ 
			label: 'composite',
			code: COMPOSITE_SHADER_SRC
		});

		return device.createRenderPipeline({
			label: 'composite',
			layout: 'auto',
			vertex: { module: shaderModule, entryPoint: 'vs' },
			fragment: {
				module: shaderModule,
				entryPoint: 'fs',
				targets: [{
					format: navigator.gpu.getPreferredCanvasFormat(),
					blend: {
						color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
						alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
					}
				}]
			},
			primitive: { topology: 'triangle-list', cullMode: 'none' }
		});
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
		size += 2 * SIZEOF_FLOAT32;     // min/max color
		size += 2 * SIZEOF_FLOAT32;     // min/max sh
		size += 1 * SIZEOF_UINT32;      // dynamic
		size += 3 * SIZEOF_FLOAT32;     // time + padding

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

		const meansBuf = this.#maybeReuseBuf(this.#gaussianBufs?.means, {
			label: 'means',

			size: gaussians.means.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		});
		device.queue.writeBuffer(meansBuf, 0, gaussians.means);

		const covsBuf = this.#maybeReuseBuf(this.#gaussianBufs?.covariances, {
			label: 'covariances',

			size: gaussians.covariances.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		});
		device.queue.writeBuffer(covsBuf, 0, gaussians.covariances);

		const opacitiesBuf = this.#maybeReuseBuf(this.#gaussianBufs?.opacities, {
			label: 'opacities',

			size: gaussians.opacities.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		});
		device.queue.writeBuffer(opacitiesBuf, 0, gaussians.opacities);

		const colorsBuf = this.#maybeReuseBuf(this.#gaussianBufs?.colors, {
			label: 'colors',

			size: gaussians.colors.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		});
		device.queue.writeBuffer(colorsBuf, 0, gaussians.colors);

		const shsBuf = this.#maybeReuseBuf(this.#gaussianBufs?.shs, {
			label: 'spherical harmomics',

			size: Math.max(gaussians.shs.byteLength, 4),
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		});
		device.queue.writeBuffer(shsBuf, 0, gaussians.shs);

		const velocitiesBuf = this.#maybeReuseBuf(this.#gaussianBufs?.velocities, {
			label: 'velocities',

			size: Math.max(gaussians.velocities.byteLength, 16),
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		});
		device.queue.writeBuffer(velocitiesBuf, 0, gaussians.velocities);

		const renderedGaussianBuf = this.#maybeReuseBuf(this.#gaussianBufs?.rendered, {
			label: 'rendered gaussians',

			size: renderedGaussianHeaderSize + gaussians.length * renderedGaussianSize,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.INDIRECT
		});

		const gaussianDepthBuf = this.#maybeReuseBuf(this.#gaussianBufs?.depths, {
			label: 'gaussian depths',

			size: gaussians.length * SIZEOF_UINT32,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		});

		const gaussianIndexBuf = this.#maybeReuseBuf(this.#gaussianBufs?.indices, {
			label: 'gaussian indices',

			size: gaussians.length * SIZEOF_UINT32,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX
		});

		return {
			means: meansBuf,
			covariances: covsBuf,
			opacities: opacitiesBuf,
			colors: colorsBuf,
			shs: shsBuf,
			velocities: velocitiesBuf,

			rendered: renderedGaussianBuf,
			depths: gaussianDepthBuf,
			indices: gaussianIndexBuf
		};
	}

	#updateParamsBuffer(view, proj, camPos, focalLengths, viewPort, time)
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

		fData.set([this.#gaussians.colorMin, this.#gaussians.colorMax], offset);
		offset += 2;

		fData.set([this.#gaussians.shMin, this.#gaussians.shMax], offset);
		offset += 2;

		uData.set([Number(this.#gaussians.dynamic)], offset);
		offset += 1;

		fData.set([time], offset);
		offset += 1;

		device.queue.writeBuffer(this.#paramsBuf, 0, data);
	}

	#createBindGroups()
	{
		const preprocessGroup = device.createBindGroup({
			label: 'gaussian preprocess',

			layout: this.#preprocessPipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: this.#paramsBuf } },

				{ binding: 1, resource: { buffer: this.#gaussianBufs.means } },
				{ binding: 2, resource: { buffer: this.#gaussianBufs.covariances } },
				{ binding: 3, resource: { buffer: this.#gaussianBufs.opacities } },
				{ binding: 4, resource: { buffer: this.#gaussianBufs.colors } },
				{ binding: 5, resource: { buffer: this.#gaussianBufs.shs } },
				{ binding: 6, resource: { buffer: this.#gaussianBufs.velocities } },

				{ binding: 7, resource: { buffer: this.#gaussianBufs.rendered } },
				{ binding: 8, resource: { buffer: this.#gaussianBufs.depths } },
				{ binding: 9, resource: { buffer: this.#gaussianBufs.indices } }
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

		const compositeGroup = device.createBindGroup({
			layout: this.#compositePipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: this.#finalTex.view },
				{ binding: 1, resource: this.#finalTex.sampler }
			]
		});

		return {
			preprocess: preprocessGroup,
			rasterize: rasterizeGroup,
			composite: compositeGroup
		};
	}

	#maybeReuseBuf(oldBuf, options)
	{
		if(oldBuf == null || oldBuf.size < options.size)
			return device.createBuffer(options);
		else
			return oldBuf;
	}
}

export default Renderer;