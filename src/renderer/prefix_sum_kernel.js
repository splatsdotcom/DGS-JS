/* prefix_sum_kernel.js
 *
 * contains an implementation of a WebGPU prefix sum
 * based on https://github.com/kishimisu/WebGPU-Radix-Sort/blob/main/src/shaders/prefix_sum.js
 * 
 * TODO: figure out licensing
 */

import { device } from './context.js';
import PREFIX_SUM_SRC from './shaders/prefix_sum.wgsl?raw';

//-------------------------//

const WORKGROUP_SIZE = 256;
const ITEMS_PER_WORKGROUP = 2 * WORKGROUP_SIZE;

const SIZEOF_UINT32 = Uint32Array.BYTES_PER_ELEMENT;

//-------------------------//

const shaderModule = device.createShaderModule({
	label: 'prefix sum',
	code: PREFIX_SUM_SRC,
});

const bindGroupLayout = device.createBindGroupLayout({
	entries: [
		{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
		{ binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
	]
});

const pipelineLayout = device.createPipelineLayout({
	bindGroupLayouts: [ bindGroupLayout ]
});

const scanPipeline = device.createComputePipeline({
	label: 'prefix sum scan pipeline',
	layout: pipelineLayout,
	compute: {
		module: shaderModule,
		entryPoint: 'reduce_downsweep',
		constants: {
			'WORKGROUP_SIZE': WORKGROUP_SIZE,
			'ITEMS_PER_WORKGROUP': ITEMS_PER_WORKGROUP,
		}
	}
});

const blockSumPipeline = device.createComputePipeline({
	label: 'prefix sum add block pipeline',
	layout: pipelineLayout,
	compute: {
		module: shaderModule,
		entryPoint: 'add_block_sums',
		constants: {
			'WORKGROUP_SIZE': WORKGROUP_SIZE,
			'ITEMS_PER_WORKGROUP': ITEMS_PER_WORKGROUP,
		}
	}
});

//-------------------------//

class PrefixSumKernel 
{
	constructor(numElems, buf) 
	{
		if(buf.size < numElems * SIZEOF_UINT32)
			throw new Error('Invalid buffer: too small to be an array of numElems Uint32s');

		this.pipelines = [];
		this.finalBlockSums = null;

		this.#createPassRecursive(numElems, buf)

		this.readbackBuf = device.createBuffer({
			size: SIZEOF_UINT32,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
		});
	}

	dispatch(pass)
	{
		for(let i = 0; i < this.pipelines.length; i++) 
		{
			const { pipeline, bindGroup, numWorkgroups } = this.pipelines[i];
			
			pass.setPipeline(pipeline);
			pass.setBindGroup(0, bindGroup);
			pass.dispatchWorkgroups(numWorkgroups);
		}
	}

	async copyTotalSum(encoder)
	{
		encoder.copyBufferToBuffer(
			this.finalBlockSums.buf,
			(this.finalBlockSums.numWorkgroups - 1) * SIZEOF_UINT32,
			this.readbackBuf,
			0, SIZEOF_UINT32
		);
	}

	async readTotalSum()
	{
		await this.readbackBuf.mapAsync(GPUMapMode.READ);
		const arrayBuffer = this.readbackBuf.getMappedRange();
		const totalSum = new Uint32Array(arrayBuffer)[0];
		this.readbackBuf.unmap();

		return totalSum;
	}

	#createPassRecursive(numElems, buf) 
	{
		//compute num workgroups:
		//-----------------
		const numWorkgroups = Math.ceil(numElems / ITEMS_PER_WORKGROUP);

		//create buffer + bind group:
		//-----------------
		const blockSumBuffer = device.createBuffer({
			label: 'prefix sum block sum',
			size: numWorkgroups * SIZEOF_UINT32,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
		});

		const bindGroup = device.createBindGroup({
			label: 'prefix sum bind group',
			layout: bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: buf           , size: numElems      * SIZEOF_UINT32 } },
				{ binding: 1, resource: { buffer: blockSumBuffer, size: numWorkgroups * SIZEOF_UINT32 } }
			]
		});

		//add scan pipeline:
		//-----------------
		this.pipelines.push({ pipeline: scanPipeline, bindGroup, numWorkgroups });

		//create recursive passes + add pipeline:
		//-----------------
		if(numWorkgroups > 1)
		{
			this.#createPassRecursive(numWorkgroups, blockSumBuffer);
			this.pipelines.push({ pipeline: blockSumPipeline, bindGroup, numWorkgroups });
		}
		else
			this.finalBlockSums = { buf: blockSumBuffer, numWorkgroups };
	}
}

export default PrefixSumKernel;