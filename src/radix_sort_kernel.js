/* radix_sort_kernel.js
 *
 * contains an implementation of a WebGPU radix sort
 */

import { device } from './context.js';

import PrefixSumKernel from "./prefix_sum_kernel.js"
import RADIX_SORT_BLOCK_SUM_SRC from './shaders/radix_sort_block_sum.wgsl?raw';
import RADIX_SORT_REORDER_SRC   from './shaders/radix_sort_reorder.wgsl?raw';

//-------------------------//

const WORKGROUP_SIZE = 64;
const ITEMS_PER_THREAD = 4;

const BITS_PER_PASS = 2; //this MUST be 2, the shaders expect it
const RADIX = 1 << BITS_PER_PASS;

const SIZEOF_UINT32 = Uint32Array.BYTES_PER_ELEMENT;

//-------------------------//

const blockSumShaderModule = device.createShaderModule({
	label: 'radix sort block sum',
	code: RADIX_SORT_BLOCK_SUM_SRC,
});

const reorderShaderModule = device.createShaderModule({
	label: 'radix sort reorder',
	code: RADIX_SORT_REORDER_SRC,
});

const blockSumBindGroupLayout = device.createBindGroupLayout({
	label: 'radix sort block sum',
	entries: [
		{
			binding: 0,
			visibility: GPUShaderStage.COMPUTE,
			buffer: { type: 'read-only-storage' }
		},
		{
			binding: 1,
			visibility: GPUShaderStage.COMPUTE,
			buffer: { type: 'storage' }
		},
		{
			binding: 2,
			visibility: GPUShaderStage.COMPUTE,
			buffer: { type: 'storage' }
		}
	]
});

const reorderBindGroupLayout = device.createBindGroupLayout({
	label: 'radix sort reorder',
	entries: [
		{
			binding: 0,
			visibility: GPUShaderStage.COMPUTE,
			buffer: { type: 'read-only-storage' }
		},
		{
			binding: 1,
			visibility: GPUShaderStage.COMPUTE,
			buffer: { type: 'storage' }
		},
		{
			binding: 2,
			visibility: GPUShaderStage.COMPUTE,
			buffer: { type: 'read-only-storage' }
		},
		{
			binding: 3,
			visibility: GPUShaderStage.COMPUTE,
			buffer: { type: 'read-only-storage' }
		},
		{
			binding: 4,
			visibility: GPUShaderStage.COMPUTE,
			buffer: { type: 'read-only-storage' }
		},
		{
			binding: 5,
			visibility: GPUShaderStage.COMPUTE,
			buffer: { type: 'storage' }
		}
	]
});

const blockSumPipelineLayout = device.createPipelineLayout(
	{ bindGroupLayouts: [ blockSumBindGroupLayout ] }
);

const reorderPipelineLayout = device.createPipelineLayout(
	{ bindGroupLayouts: [ reorderBindGroupLayout ] }
);

const blockSumPipelines = new Array(32 / BITS_PER_PASS);
const reorderPipelines = new Array(32 / BITS_PER_PASS);
for(let bit = 0; bit < 32; bit += BITS_PER_PASS)
{
	blockSumPipelines[bit / BITS_PER_PASS] = device.createComputePipeline({
		label: 'radix sort block sum',
		layout: blockSumPipelineLayout,
		compute: {
			module: blockSumShaderModule,
			entryPoint: 'radix_sort',
			constants: {
				// 'WORKGROUP_SIZE': WORKGROUP_SIZE,
				'CURRENT_BIT': bit,
			}
		}
	});

	reorderPipelines[bit / BITS_PER_PASS] = device.createComputePipeline({
		label: 'radix sort reorder',
		layout: reorderPipelineLayout,
		compute: {
			module: reorderShaderModule,
			entryPoint: 'radix_sort_reorder',
			constants: {
				// 'WORKGROUP_SIZE': WORKGROUP_SIZE,
				'CURRENT_BIT': bit,
			}
		}
	});
}

//-------------------------//

class RadixSortKernel
{
	constructor(numElems, keysBuf, valsBuf, bitCount) 
	{
		if(bitCount <= 0 || bitCount > 32)
			throw new Error('Invalid bit count: must be in (0, 32]');
		if(bitCount % (2 * BITS_PER_PASS) !== 0) 
			throw new Error('Invalid bit count: must be a multiple of 2 * BITS_PER_PASS');
		if(keysBuf.size < numElems * SIZEOF_UINT32)
			throw new Error('Invalid keys buffer: too small to be an array of numElems Uint32s');
		if(valsBuf.size < numElems * SIZEOF_UINT32)
			throw new Error('Invalid values buffer: too small to be an array of numElems Uint32s');

		this.numElems = numElems;
		this.bitCount = bitCount;

		this.numWorkgroups = Math.ceil(numElems / WORKGROUP_SIZE / ITEMS_PER_THREAD);
		this.prefixSumNumWorkgroups = RADIX * Math.ceil(numElems / WORKGROUP_SIZE);

		this.pipelines = [];
		this.dataBufs = {
			keys: keysBuf,
			values: valsBuf
		};

		this.#createPipelines()
	}

	dispatch(pass) 
	{
		for(let i = 0; i < this.bitCount / BITS_PER_PASS; i++) 
		{
			const blockSumPipeline = blockSumPipelines[i];
			const reorderPipeline = reorderPipelines[i];

			const blockSumBindGroup = this.bindGroups[i % 2].blockSum;
			const reorderBindGroup = this.bindGroups[i % 2].reorder;

			pass.setPipeline(blockSumPipeline);
			pass.setBindGroup(0, blockSumBindGroup);
			pass.dispatchWorkgroups(this.numWorkgroups);

			this.prefixSum.kernel.dispatch(pass);

			pass.setPipeline(reorderPipeline);
			pass.setBindGroup(0, reorderBindGroup);
			pass.dispatchWorkgroups(this.numWorkgroups);
		}
	}

	#createPipelines() 
	{
		this.prefixSum = this.#createPrefixSumKernel();
		this.tmpDataBufs = this.#createTempBuffers();

		this.bindGroups = new Array(2);
		this.bindGroups[0] = this.#createBindGroups(
			this.dataBufs.keys, this.dataBufs.values, this.tmpDataBufs.keys, this.tmpDataBufs.values
		);
		this.bindGroups[1] = this.#createBindGroups(
			this.tmpDataBufs.keys, this.tmpDataBufs.values, this.dataBufs.keys, this.dataBufs.values
		);
	}

	#createPrefixSumKernel() 
	{
		const prefixBlockSumBuffer = device.createBuffer({
			label: 'radix sort prefix block sum',
			size: this.prefixSumNumWorkgroups * SIZEOF_UINT32,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
		});

		const prefixSumKernel = new PrefixSumKernel(
			this.prefixSumNumWorkgroups,
			prefixBlockSumBuffer
		);

		return {
			kernel: prefixSumKernel,
			buffer: prefixBlockSumBuffer
		};
	}

	#createTempBuffers() 
	{
		const tmpKeysBuffer = device.createBuffer({
			label: 'radix sort tmp keys',
			size: this.numElems * SIZEOF_UINT32,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
		});

		const tmpValuesBuffer = device.createBuffer({
			label: 'radix sort tmp values',
			size: this.numElems * SIZEOF_UINT32,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
		});

		const localPrefixSumBuffer = device.createBuffer({
			label: 'radix sort local prefix sum',
			size: this.numElems * SIZEOF_UINT32,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
		});

		return {
			keys: tmpKeysBuffer,
			values: tmpValuesBuffer,
			localPrefixSum: localPrefixSumBuffer
		};
	}

	#createBindGroups(inKeys, inValues, outKeys, outValues)
	{
		const blockSumBindGroup = device.createBindGroup({
			layout: blockSumBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: inKeys                         , size: this.numElems * SIZEOF_UINT32 } },
				{ binding: 1, resource: { buffer: this.tmpDataBufs.localPrefixSum, size: this.numElems * SIZEOF_UINT32 } },
				{ binding: 2, resource: { buffer: this.prefixSum.buffer          , size: this.prefixSumNumWorkgroups * SIZEOF_UINT32 } },
			]
		});

		const reorderBindGroup = device.createBindGroup({
			layout: reorderBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: inKeys                         , size: this.numElems * SIZEOF_UINT32 } },
				{ binding: 1, resource: { buffer: outKeys                        , size: this.numElems * SIZEOF_UINT32 } },
				{ binding: 2, resource: { buffer: this.tmpDataBufs.localPrefixSum, size: this.numElems * SIZEOF_UINT32 } },
				{ binding: 3, resource: { buffer: this.prefixSum.buffer          , size: this.prefixSumNumWorkgroups * SIZEOF_UINT32 } },
				{ binding: 4, resource: { buffer: inValues                       , size: this.numElems * SIZEOF_UINT32 } },
				{ binding: 5, resource: { buffer: outValues                      , size: this.numElems * SIZEOF_UINT32 } }
			]
		});

		return {
			blockSum: blockSumBindGroup,
			reorder: reorderBindGroup
		};
	}
}

export default RadixSortKernel;