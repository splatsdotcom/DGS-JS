/* prefix_sum.wgsl
 *
 * shader for performing an exclusive-scan prefix sum
 * based on https://github.com/kishimisu/WebGPU-Radix-Sort/blob/main/src/shaders/prefix_sum.js
 *
 * TODO: figure out licensing
 */

override WORKGROUP_SIZE: u32;
override ITEMS_PER_WORKGROUP: u32;

//-------------------------//

@group(0) @binding(0) var<storage, read_write> u_input: array<u32>;
@group(0) @binding(1) var<storage, read_write> u_sum: array<u32>;

var<workgroup> s_temp: array<u32, ITEMS_PER_WORKGROUP*2>;

//-------------------------//

@compute @workgroup_size(WORKGROUP_SIZE) 
fn reduce_downsweep(@builtin(workgroup_id) WID: vec3<u32>, @builtin(local_invocation_index) TID: u32)
{
	//compute IDs:
	//---------------
	let GID = WID.x * WORKGROUP_SIZE + TID;
	let ELM_TID = TID * 2u;
	let ELM_GID = GID * 2u;
	
	//load input into shared memory:
	//---------------
	s_temp[ELM_TID]      = select(u_input[ELM_GID]     , 0u, ELM_GID      >= arrayLength(&u_input));
	s_temp[ELM_TID + 1u] = select(u_input[ELM_GID + 1u], 0u, ELM_GID + 1u >= arrayLength(&u_input));

	//up-sweep:
	//---------------
	var offset = 1u;
	for(var d = ITEMS_PER_WORKGROUP >> 1u; d > 0u; d >>= 1u) 
	{
		workgroupBarrier();
		if(TID < d) 
		{
			let ai = offset * (ELM_TID + 1u) - 1u;
			let bi = offset * (ELM_TID + 2u) - 1u;
			s_temp[bi] += s_temp[ai];
		}

		offset <<= 1;
	}

	//save sum, clear last element:
	//---------------
	if(TID == 0u)
	{
		u_sum[WID.x] = s_temp[ITEMS_PER_WORKGROUP - 1u];
		s_temp[ITEMS_PER_WORKGROUP - 1u] = 0u;
	}

	//down-sweep:
	//---------------
	for(var d = 1u; d < ITEMS_PER_WORKGROUP; d <<= 1u)
	{
		offset >>= 1u;
		workgroupBarrier();

		if(TID < d) 
		{
			let ai = offset * (ELM_TID + 1u) - 1u;
			let bi = offset * (ELM_TID + 2u) - 1u;

			let t = s_temp[ai];
			s_temp[ai] = s_temp[bi];
			s_temp[bi] += t;
		}
	}
	workgroupBarrier();

	//write results:
	//---------------
	if(ELM_GID >= arrayLength(&u_input))
	{
		return;
	}
	u_input[ELM_GID] = s_temp[ELM_TID];

	if(ELM_GID + 1u >= arrayLength(&u_input)) 
	{
		return;
	}
	u_input[ELM_GID + 1] = s_temp[ELM_TID + 1];
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn add_block_sums(@builtin(workgroup_id) WID: vec3<u32>, @builtin(local_invocation_index) TID: u32)
{
	//compute IDs:
	//---------------
	let GID = WID.x * WORKGROUP_SIZE + TID;
	let ELM_ID = GID * 2;

	if(ELM_ID >= arrayLength(&u_input)) 
	{
		return;
	}

	//add block sum:
	//---------------
	let blockSum = u_sum[WID.x];
	u_input[ELM_ID] += blockSum;

	if(ELM_ID + 1 >= arrayLength(&u_input)) 
	{
		return;
	}

	u_input[ELM_ID + 1] += blockSum;
}