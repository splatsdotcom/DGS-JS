/* renderer.js
 *
 * contains the implementation of the gaussian splat renderer
 */

const SIZEOF_FLOAT32 = Float32Array.BYTES_PER_ELEMENT;
const SIZEOF_UINT32  = Uint32Array.BYTES_PER_ELEMENT;

const GAUSSIAN_PREPROCESS_WORKGROUP_SIZE = 64;
const RENDERER_NUM_TIMESTAMP_QUERIES = 4;

const RESORT_DIR_CUTOFF = 0.001;
const RESORT_POS_CUTOFF = 0.001; //TODO: tweak these
const RESORT_TIME_CUTOFF = 0.0;

//-------------------------//

import { mat4, vec3 } from 'gl-matrix';
import { DGS, adapter, device } from './context.js';
import Sorter from './sorter.js';

import GAUSSIAN_PREPROCESS_SHADER_SRC from './shaders/gaussian_preprocess.wgsl';
import GAUSSIAN_RASTERIZE_SHADER_SRC  from './shaders/gaussian_rasterize.wgsl';
import COMPOSITE_SHADER_SRC from './shaders/composite.wgsl';

//-------------------------//

class Renderer
{
	constructor(canvas)
	{
		this.#canvas = canvas;
	}

	async initialize()
	{
		this.#dgs = await DGS;
		this.#device = await device;
		this.#adapter = await adapter;

		this.#context = this.#createContext();
		this.#finalTex = this.#createFinalTex();
		this.#preprocessPipeline = this.#createPreprocessPipeline();
		this.#rasterizePipeline = this.#createRasterizePipeline();
		this.#compositePipeline = this.#createCompositePipeline();
		this.#geomBufs = this.#createGeometryBuffers();
		this.#paramsBuf = this.#createParamsBuffer();

		if(this.#adapter.features.has('timestamp-query'))
			this.#profiler = this.#createProfiler();
	}

	resize()
	{
		this.#finalTex = this.#createFinalTex()
	}

	setGaussians(gaussians)
	{
		//TODO: improve perf !!! scene may be very large, so we dont want to combine + reupload

		this.#gaussians = this.#scene ? this.#dgs.combine(gaussians, this.#scene) : gaussians;
		this.#gaussianBufs = this.#createGaussianBufs(this.#gaussians);

		const sorter = new Sorter(this.#gaussians, (indices, duration) => {
			this.#sortPending = false;
			if(this.#sorter != sorter)
				return;

			this.#uploadSortedIndices(indices);

			this.#sorted = true;
			this.#latestProfile.lastSortTime = duration;
		});

		this.#sorted = false; //TODO: allow you to give the gaussians presorted !
		this.#lastSortParams = null;
		this.#sorter = sorter;
	}

	setScene(gaussians)
	{
		this.#scene = gaussians;
	}

	setPointSize(pointSize)
	{
		this.#pointModeSize = pointSize;
	}

	draw(view, proj, time, params = {}, profile = false)
	{
		if(!this.#gaussians)
			return;

		if(this.#profiler == null)
			profile = false;

		//resort if needed:
		//-----------------
		if(!this.#sortPending && this.#shouldResort(view, time)) 
		{
			this.#sortPending = true;
			this.#sorter.sort(view, proj, time);

			this.#lastSortParams = {
				view: view.slice(),
				time: time
			};
		}

		if(!this.#sorted)
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
		if(profile)
		{
			queryBuffer = this.#device.createBuffer({
				size: RENDERER_NUM_TIMESTAMP_QUERIES * 8,
				usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
			});

			queryReadbackBuffer = this.#device.createBuffer({
				size: RENDERER_NUM_TIMESTAMP_QUERIES * 8,
				usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
			});
		}

		//create command encoder:
		//---------------
		const encoder = this.#device.createCommandEncoder();

		//preprocess:
		//---------------
		const preprocessPass = encoder.beginComputePass({
			timestampWrites: profile ? {
				querySet: this.#profiler.querySet,
				beginningOfPassWriteIndex: 0,
				endOfPassWriteIndex: 1
			} : undefined
		});

		preprocessPass.setPipeline(this.#preprocessPipeline);
		preprocessPass.setBindGroup(0, bindGroups.preprocess);

		if(this.#numGaussiansVisible > 0)
			preprocessPass.dispatchWorkgroups(Math.ceil(this.#numGaussiansVisible / GAUSSIAN_PREPROCESS_WORKGROUP_SIZE));

		preprocessPass.end();

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

			timestampWrites: profile ? {
				querySet: this.#profiler.querySet,
				beginningOfPassWriteIndex: 2,
				endOfPassWriteIndex: 3
			} : undefined
		});

		rasterPass.setPipeline(this.#rasterizePipeline);
		rasterPass.setVertexBuffer(0, this.#geomBufs.vertex);
		rasterPass.setIndexBuffer(this.#geomBufs.index, 'uint16');
		rasterPass.setBindGroup(0, bindGroups.rasterize);

		if(this.#numGaussiansVisible > 0)
			rasterPass.drawIndexed(6, this.#numGaussiansVisible);

		rasterPass.end();

		//composite:
		//---------------
		const backgroundColor = params.backgroundColor ?? [0, 0, 0];
		const compositePass = encoder.beginRenderPass({
			label: 'composite',
			colorAttachments: [{
				view: this.#context.getCurrentTexture().createView(),
				clearValue: { r: backgroundColor[0], g: backgroundColor[1], b: backgroundColor[2], a: 1.0 },
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
		if(profile)
		{
			encoder.resolveQuerySet(this.#profiler.querySet, 0, RENDERER_NUM_TIMESTAMP_QUERIES, queryBuffer, 0);
			encoder.copyBufferToBuffer(queryBuffer, 0, queryReadbackBuffer, 0, RENDERER_NUM_TIMESTAMP_QUERIES * 8);
		}

		this.#device.queue.submit([encoder.finish()]);

		//read profiling data:
		//-----------------
		if(profile)
		{
			queryReadbackBuffer.mapAsync(GPUMapMode.READ).then(() => {
				const timestampsBuf = queryReadbackBuffer.getMappedRange();
				const timestamps = new BigUint64Array(timestampsBuf);

				this.#profiler.accumFrames++;
				this.#profiler.accumTime += dt;
				this.#profiler.accumPreprocessTime += Number(timestamps[1] - timestamps[0]);
				this.#profiler.accumRasterTime     += Number(timestamps[3] - timestamps[2]);

				queryReadbackBuffer.unmap();

				if(this.#profiler.accumTime >= 1000.0)
				{
					const avgPreprocessTime = (this.#profiler.accumPreprocessTime / 1000000) / this.#profiler.accumFrames;
					const avgRasterTime     = (this.#profiler.accumRasterTime     / 1000000) / this.#profiler.accumFrames;
					const avgTime = avgPreprocessTime + avgRasterTime;

					this.#latestProfile.preprocessTime = avgPreprocessTime,
					this.#latestProfile.rasterTime = avgRasterTime,
					this.#latestProfile.totalTime = avgTime

					this.#profiler.accumFrames = 0;
					this.#profiler.accumTime = 0.0;
					this.#profiler.accumPreprocessTime = 0.0;
					this.#profiler.accumRasterTime = 0.0;
				}
			});
		}
	}

	get numGaussians()
	{
		return this.#gaussians?.length ?? 0;
	}

	get numGaussiansVisible()
	{
		return this.#numGaussiansVisible ?? 0;
	}

	get performanceProfile()
	{
		return this.#latestProfile;
	}

	//-------------------------//

	#dgs = null;
	#device = null;
	#adapter = null;

	#canvas = null;
	#context = null;
	#finalTex = null;
	#preprocessPipeline = null;
	#rasterizePipeline = null;
	#compositePipeline = null;
	#profiler = null;

	#scene = null;
	#gaussians = null;
	#pointModeSize = null;

	#gaussianBufs = null;
	#geomBufs = null;
	#paramsBuf = null;
	#numGaussiansVisible = 0;

	#sorter = null;
	#sorted = false;
	#sortPending = false;
	#lastSortParams = null;

	#lastRenderTime = null;

	#latestProfile = {};
	
	//-------------------------//

	#createContext()
	{
		const context = this.#canvas.getContext('webgpu');
		context.configure({
			device: this.#device,
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

		const tex = this.#device.createTexture({
			size: [width, height, 1],
			format: format,
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
		});

		return {
			tex: tex,
			view: tex.createView(),
			sampler: this.#device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
		}
	}

	#createPreprocessPipeline()
	{
		const shaderModule = this.#device.createShaderModule({
			label: 'gaussian preprocess',

			code: GAUSSIAN_PREPROCESS_SHADER_SRC,
		});

		return this.#device.createComputePipeline({
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
		const shaderModule = this.#device.createShaderModule({
			label: 'gaussian rasterize',

			code: GAUSSIAN_RASTERIZE_SHADER_SRC 
		});

		const pipeline = this.#device.createRenderPipeline({
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
		const shaderModule = this.#device.createShaderModule({ 
			label: 'composite',
			code: COMPOSITE_SHADER_SRC
		});

		return this.#device.createRenderPipeline({
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
		const querySet = this.#device.createQuerySet({
			type: 'timestamp',
			count: RENDERER_NUM_TIMESTAMP_QUERIES
		});

		return {
			querySet: querySet,
			accumFrames: 0,
			accumTime: 0,
			accumRasterTime: 0,
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
		const vertexBuffer = this.#device.createBuffer({
			label: 'quad vertices',

			size: quadVertices.byteLength,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
		});
		this.#device.queue.writeBuffer(vertexBuffer, 0, quadVertices);

		//create index buffer:
		//---------------
		const quadIndices = new Uint16Array([
			0, 1, 2, 
			0, 2, 3
		]);
		const indexBuffer = this.#device.createBuffer({
			label: 'quad indices',

			size: quadIndices.byteLength,
			usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
		});
		this.#device.queue.writeBuffer(indexBuffer, 0, quadIndices);

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
		size += 1 * SIZEOF_FLOAT32;     // time
		size += 2 * SIZEOF_FLOAT32;     // focal lengths
		size += 2 * SIZEOF_FLOAT32;     // viewport
		size += 1 * SIZEOF_FLOAT32;     // point mode size
		size += 1 * SIZEOF_UINT32;      // num gaussians
		size += 1 * SIZEOF_UINT32;      // dynamic
		size += 1 * SIZEOF_UINT32;      // sh degree
		size += 2 * SIZEOF_FLOAT32;     // min/max scale
		size += 2 * SIZEOF_FLOAT32;     // min/max color
		size += 2 * SIZEOF_FLOAT32;     // min/max sh
		size += 2 * SIZEOF_UINT32;      // padding

		return this.#device.createBuffer({
			label: 'params',

			size: size,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
	}

	#createGaussianBufs(gaussians)
	{
		const bufs = {};

		//create data bufs:
		//---------------
		const properties = [
			{ name: 'means'     , alignment: 4 * SIZEOF_FLOAT32 },
			{ name: 'scales'    , alignment:     SIZEOF_UINT32  },
			{ name: 'rotations' , alignment:     SIZEOF_UINT32  },
			{ name: 'opacities' , alignment:     SIZEOF_UINT32  },
			{ name: 'colors'    , alignment:     SIZEOF_UINT32  },
			{ name: 'shs'       , alignment:     SIZEOF_UINT32  },
			{ name: 'velocities', alignment: 4 * SIZEOF_FLOAT32 },
		]
		
		properties.forEach((prop) => {
			bufs[prop.name] = this.#maybeReuseBuf(this.#gaussianBufs?.[prop.name], {
				label: prop.name,

				size: this.#alignNonzero(gaussians[prop.name].byteLength, prop.alignment),
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
			});
			this.#writeBufferUnaligned(bufs[prop.name], gaussians[prop.name]);
		})

		//create render bufs:
		//---------------
		bufs.sortedIndices = this.#maybeReuseBuf(this.#gaussianBufs?.sortedIndices, {
			label: 'sorted indices',

			size: Math.max(gaussians.length, 1) * SIZEOF_UINT32,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE
		});
		bufs.rendered = this.#maybeReuseBuf(this.#gaussianBufs?.rendered, {
			label: 'rendered gaussians',

			size: Math.max(gaussians.length, 1) * 12 * SIZEOF_FLOAT32,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.INDIRECT
		});

		//return:
		//---------------
		return bufs
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

		fData.set([time], offset);
		offset += 1;

		fData.set(focalLengths, offset);
		offset += 2;

		fData.set(viewPort, offset);
		offset += 2;

		fData.set([this.#pointModeSize ?? 0.0], offset);
		offset += 1;

		uData.set([this.#numGaussiansVisible], offset);
		offset += 1;

		uData.set([Number(this.#gaussians.dynamic)], offset);
		offset += 1;

		uData.set([this.#gaussians.shDegree], offset);
		offset += 1;

		fData.set([this.#gaussians.scaleMin, this.#gaussians.scaleMax], offset);
		offset += 2;

		fData.set([this.#gaussians.colorMin, this.#gaussians.colorMax], offset);
		offset += 2;

		fData.set([this.#gaussians.shMin, this.#gaussians.shMax], offset);
		offset += 2;

		this.#device.queue.writeBuffer(this.#paramsBuf, 0, data);
	}

	#createBindGroups()
	{
		const preprocessGroup = this.#device.createBindGroup({
			label: 'gaussian preprocess',

			layout: this.#preprocessPipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: this.#paramsBuf } },

				{ binding: 1, resource: { buffer: this.#gaussianBufs.means } },
				{ binding: 2, resource: { buffer: this.#gaussianBufs.scales } },
				{ binding: 3, resource: { buffer: this.#gaussianBufs.rotations } },
				{ binding: 4, resource: { buffer: this.#gaussianBufs.opacities } },
				{ binding: 5, resource: { buffer: this.#gaussianBufs.colors } },
				{ binding: 6, resource: { buffer: this.#gaussianBufs.shs } },
				{ binding: 7, resource: { buffer: this.#gaussianBufs.velocities } },
				{ binding: 8, resource: { buffer: this.#gaussianBufs.sortedIndices } },

				{ binding: 9, resource: { buffer: this.#gaussianBufs.rendered } }
			]
		});

		const rasterizeGroup = this.#device.createBindGroup({
			label: 'gaussian rasterize',

			layout: this.#rasterizePipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: this.#paramsBuf } },
				{ binding: 1, resource: { buffer: this.#gaussianBufs.rendered } }
			]
		});

		const compositeGroup = this.#device.createBindGroup({
			label: 'composite',

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

	#shouldResort(view, time)
	{
		if(this.#lastSortParams == null)
			return true;

		const lastView = this.#lastSortParams.view;

		const viewDir = [ view[0 * 4 + 2], view[1 * 4 + 2], view[2 * 4 + 2] ];
		const camPos  = [ view[3 * 4 + 0], view[3 * 4 + 1], view[3 * 4 + 2] ];

		const lastViewDir = [ lastView[0 * 4 + 2], lastView[1 * 4 + 2], lastView[2 * 4 + 2] ];
		const lastCamPos  = [ lastView[3 * 4 + 0], lastView[3 * 4 + 1], lastView[3 * 4 + 2] ];

		const viewDiff = 1.0 - (
			viewDir[0] * lastViewDir[0] + 
			viewDir[1] * lastViewDir[1] +
			viewDir[2] * lastViewDir[2]
		);
		const posDiff = (
			Math.pow(camPos[0] - lastCamPos[0], 2.0) +
			Math.pow(camPos[1] - lastCamPos[1], 2.0) +
			Math.pow(camPos[2] - lastCamPos[2], 2.0)
		);
		const timeDiff = Math.abs(time - this.#lastSortParams.time);

		return (
			viewDiff > RESORT_DIR_CUTOFF ||
			posDiff  > RESORT_POS_CUTOFF ||
			timeDiff > RESORT_TIME_CUTOFF
		);
	}

	#uploadSortedIndices(indices)
	{
		this.#numGaussiansVisible = indices.length;
		this.#device.queue.writeBuffer(this.#gaussianBufs.sortedIndices, 0, indices);
	}

	#maybeReuseBuf(oldBuf, options)
	{
		if(oldBuf == null || oldBuf.size < options.size)
		{
			oldBuf?.destroy();
			return this.#device.createBuffer(options);
		}
		else
			return oldBuf;
	}

	#writeBufferUnaligned(dst, src) 
	{
		let buffer, byteOffset, byteLength;
		if(src instanceof ArrayBuffer) 
		{
			buffer = src;
			byteOffset = 0;
			byteLength = src.byteLength;
		} 
		else 
		{
			buffer = src.buffer;
			byteOffset = src.byteOffset;
			byteLength = src.byteLength;
		}

		const alignedLength = byteLength & ~3;
		if(alignedLength > 0) 
			this.#device.queue.writeBuffer(dst, 0, buffer, byteOffset, alignedLength);

		const tail = byteLength - alignedLength;
		if(tail > 0) 
		{
			const scratch = new Uint8Array(4);
			scratch.set(new Uint8Array(buffer, byteOffset + alignedLength, tail));

			this.#device.queue.writeBuffer(dst, alignedLength, scratch, 0, 4);
		}
	}

	#alignNonzero(a, b)
	{
		if(a == 0)
			return b;

		return (a + b - 1) & ~(b - 1);
	}
}

export default Renderer;