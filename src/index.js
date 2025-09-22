/* index.js
 * 
 * contains the core logic
 */

const CANVAS_RESOLUTION_SCALE = 2;

const SIZEOF_FLOAT32 = Float32Array.BYTES_PER_ELEMENT;

//-------------------------//

import { mat4, mat3, vec3 } from 'gl-matrix';
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

		this.#gaussianBuf = this.#createGaussianBuffer(); //TEMP!

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

	#gaussianBuf = null; //TEMP!
	#camAngle = 0.0; //TEMP!

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

	#render(timestamp)
	{
		//create cam/proj matrices:
		//---------------

		//TEMP!!! we want these supplied by user eventually!
		
		this.#camAngle += 0.01;
		const eye = vec3.fromValues(Math.sin(this.#camAngle)*5, 2, Math.cos(this.#camAngle)*5);
		const view = mat4.create();
		mat4.lookAt(view, eye, [0,0,0], [0,1,0]);

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
		pass.setIndexBuffer(this.#geomBufs.index, 'uint16');
		pass.setBindGroup(0, bindGroups.gaussian);

		const pointCount = 1;
		pass.drawIndexed(6, pointCount); //TEMP!

		pass.end();
		device.queue.submit([encoder.finish()]);

		//loop:
		//---------------
		requestAnimationFrame((t) => {
			this.#render(t)
		});
	}


	//TEMP! just setting up some test gaussians for now
	#createGaussianBuffer()
	{
		let alignedMat3 = (m) => {
			return new Float32Array([...m.slice(0, 3), 0.0, ...m.slice(3, 6), 0.0, ...m.slice(6, 9), 0.0]);
		};

		const cov = mat3.identity(mat3.create());
		const mean = vec3.zero(vec3.create());

		const gaussianBuffer = device.createBuffer({
			size: 4 * 3 * Float32Array.BYTES_PER_ELEMENT + 4 * Float32Array.BYTES_PER_ELEMENT,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		});
		device.queue.writeBuffer(gaussianBuffer, 0, alignedMat3(cov));
		device.queue.writeBuffer(gaussianBuffer, 4 * 3 * Float32Array.BYTES_PER_ELEMENT, mean);


		return gaussianBuffer;
	}
}

customElements.define('splat-player', SplatPlayer);
