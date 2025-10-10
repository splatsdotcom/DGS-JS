/* radix_sort_reorder.js
 *
 * performs the actual reordering of key/values for radix sort
 */

const WORKGROUP_SIZE: u32 = 64u; // safari doesn't like if this is an override
override CURRENT_BIT: u32;

const ITEMS_PER_THREAD = 4u;

//-------------------------//

@group(0) @binding(0) var<storage, read> u_inputKeys: array<u32>;
@group(0) @binding(1) var<storage, read_write> outputKeys: array<u32>;

@group(0) @binding(2) var<storage, read> u_localPrefixSums: array<u32>;
@group(0) @binding(3) var<storage, read> u_prefixBlockSums: array<u32>;

@group(0) @binding(4) var<storage, read> u_inputValues: array<u32>;
@group(0) @binding(5) var<storage, read_write> outputValues: array<u32>;

//-------------------------//

@compute @workgroup_size(WORKGROUP_SIZE)
fn radix_sort_reorder(@builtin(global_invocation_id) GID: vec3u, @builtin(workgroup_id) WID: vec3u, @builtin(num_workgroups) NWG: vec3u)
{
	//compute item range:
	//---------------
	let gid = GID.x;
	let wid = WID.x;
	let nwg = NWG.x;

	let itemStart = gid * ITEMS_PER_THREAD;
	
	var numItems: u32;
	if(itemStart < arrayLength(&u_inputKeys))
	{
		numItems = min(ITEMS_PER_THREAD, arrayLength(&u_inputKeys) - itemStart);
	}
	else
	{
		return;
	}

	//reorder:
	//---------------
	for(var i = 0u; i < numItems; i++)
	{
		let key = u_inputKeys[itemStart + i];
		let value = u_inputValues[itemStart + i];

		let localPrefixSum = u_localPrefixSums[itemStart + i];

		let extractedBits = (key >> CURRENT_BIT) & 3u;
		let binIdx = extractedBits * nwg + wid;
		let sortedPos = u_prefixBlockSums[binIdx] + localPrefixSum;
		
		outputKeys[sortedPos] = key;
		outputValues[sortedPos] = value;
	}
}