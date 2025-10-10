/* radix_sort_block_sum.wgsl
 *
 * shader for performing the block prefix sums for radix sort
 */

const WORKGROUP_SIZE: u32 = 64u; // safari doesn't like if this is an override
override CURRENT_BIT: u32;

const ITEMS_PER_THREAD = 4u;

//-------------------------//

@group(0) @binding(0) var<storage, read> u_input: array<u32>;
@group(0) @binding(1) var<storage, read_write> u_localPrefixSums: array<u32>;
@group(0) @binding(2) var<storage, read_write> u_blockSums: array<u32>;

var<workgroup> s_prefixSum: array<vec4u, 2u * (WORKGROUP_SIZE + 1u)>;

//-------------------------//

@compute @workgroup_size(WORKGROUP_SIZE)
fn radix_sort(@builtin(local_invocation_index) TID: u32, @builtin(workgroup_id) WID: vec3<u32>, @builtin(num_workgroups) NWG: vec3<u32>)
{
	//compute IDs:
	//---------------
	let tid = TID;
	let wid = WID.x;
	let gid = wid * WORKGROUP_SIZE + tid;
	let nwg = NWG.x;

	let wgSizePlusOne = WORKGROUP_SIZE + 1u;
	let lastTid = min(WORKGROUP_SIZE, arrayLength(&u_input) - wid * WORKGROUP_SIZE) - 1;

	let itemStart = gid * ITEMS_PER_THREAD;
	var numItems = 0u;
	if(itemStart < arrayLength(&u_input))
	{
		numItems = min(ITEMS_PER_THREAD, arrayLength(&u_input) - itemStart);
	}

	//extract bits of keys:
	//---------------
	var digits: array<u32, ITEMS_PER_THREAD>;
	for(var i = 0u; i < numItems; i++)
	{
		let key = u_input[itemStart + i];
		digits[i] = (key >> CURRENT_BIT) & 3u;
	}

	//get digit bin counts and local thread orders:
	//---------------
	var numMatching: vec4u;
	var threadOrder: array<u32, ITEMS_PER_THREAD>;
	for(var digit = 0u; digit < 4u; digit++) 
	{
		numMatching[digit] = 0u;
		for(var i = 0u; i < numItems; i++)
		{
			if(digits[i] == digit)
			{
				threadOrder[i] = numMatching[digit];
				numMatching[digit]++;
			}
		}
	}

	//compute prefix sum:
	//---------------
	var swapOffset = 0u;
	var inOffset = tid;
	var outOffset = tid + wgSizePlusOne;

	s_prefixSum[inOffset + 1u] = numMatching;
	workgroupBarrier();

	var prefixSum = vec4u(0u);
	for(var offset = 1u; offset < WORKGROUP_SIZE; offset <<= 1u) 
	{
		if(tid >= offset) 
		{
			prefixSum = s_prefixSum[inOffset] + s_prefixSum[inOffset - offset];
		} 
		else 
		{
			prefixSum = s_prefixSum[inOffset];
		}

		s_prefixSum[outOffset] = prefixSum;
		
		outOffset = inOffset;
		swapOffset = wgSizePlusOne - swapOffset;
		inOffset = tid + swapOffset;
		
		workgroupBarrier();
	}

	if(tid == lastTid) 
	{
		let totalSum = prefixSum + numMatching;

		for(var digit = 0u; digit < 4u; digit++) 
		{
			u_blockSums[digit * nwg + wid] = totalSum[digit];
		}
	}

	//store local prefix sum:
	//---------------
	for(var i = 0u; i < numItems; i++)
	{
		u_localPrefixSums[itemStart + i] = prefixSum[digits[i]] + threadOrder[i];
	}

}