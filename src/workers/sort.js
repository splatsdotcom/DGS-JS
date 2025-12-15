/* workers/sort.js
 *
 * implements the gaussian sorting routine
 */

const UINT16_MAX = (1 << 16) - 1;
const CLIP_THRESHOLD = 1.2;

//-------------------------------------------//

let count;
let dynamic;
let means;
let velocities;
let outIndices;

let sortIndices;
let sortDepths;
let counts;

onmessage = (e) => {
	if(e.data.type === 'init')
	{
		count = e.data.count;
		dynamic = e.data.dynamic;

		means      = new Float32Array(e.data.sab, e.data.meansOffset     , count * 4);
		velocities = new Float32Array(e.data.sab, e.data.velocitiesOffset, dynamic ? count * 4 : 0);
		outIndices = new  Uint32Array(e.data.sab, e.data.indicesOffset   , count);

		sortIndices = new Uint32Array(count);
		sortDepths  = new Float32Array(count);
		counts      = new Uint32Array(UINT16_MAX);

		return;
	}

	if(e.data.type !== 'sort')
		throw new Error('Invalid command: ', e.data.type);

	const startTime = performance.now();

	//unpack command:
	//---------------
	const view = e.data.view;
	const proj = e.data.proj;
	const time = e.data.time;

	//precompute depths + min/max:
	//---------------
	let minDepth = Infinity;
	let maxDepth = -Infinity;
	let sortCount = 0;

	for(let i = 0; i < count; i++)
	{
		const idx = i * 4;

		let x = means[idx + 0];
		let y = means[idx + 1];
		let z = means[idx + 2];
		if(dynamic)
		{
			x += velocities[idx + 0] * time;
			y += velocities[idx + 1] * time;
			z += velocities[idx + 2] * time;
		}

		const cx = view[0] * x + view[4] * y + view[8]  * z + view[12];
		const cy = view[1] * x + view[5] * y + view[9]  * z + view[13];
		const cz = view[2] * x + view[6] * y + view[10] * z + view[14];
		const cw = view[3] * x + view[7] * y + view[11] * z + view[15];

		const px = proj[0] * cx + proj[4] * cy + proj[8]  * cz + proj[12] * cw;
		const py = proj[1] * cx + proj[5] * cy + proj[9]  * cz + proj[13] * cw;
		const pz = proj[2] * cx + proj[6] * cy + proj[10] * cz + proj[14] * cw;
		const pw = proj[3] * cx + proj[7] * cy + proj[11] * cz + proj[15] * cw;

		const clip = CLIP_THRESHOLD * pw;
		if(px >  clip || py >  clip || pz >  clip ||
		   px < -clip || py < -clip || pz < -clip)
			continue;

		const depth = -cz;
		if(depth < minDepth) 
			minDepth = depth;
		if(depth > maxDepth) 
			maxDepth = depth;

		sortIndices[sortCount] = i;
		sortDepths [sortCount] = depth;
		sortCount++;
	}

	//compute counts:
	//---------------
	counts.fill(0);

	const scale = UINT16_MAX / (maxDepth - minDepth);
	for(let i = 0; i < sortCount; i++) 
	{
		let idx = ((sortDepths[i] - minDepth) * scale) | 0;
		if(idx >= UINT16_MAX) 
			idx = UINT16_MAX - 1;

		counts[idx]++;
	}

	//prefix sum:
	//---------------
	let total = 0;
	for(let i = 0; i < UINT16_MAX; i++) 
	{
		const c = counts[i];
		counts[i] = total;
		total += c;
	}

	//output:
	//---------------
	for(let i = 0; i < sortCount; i++)
	{
		let depthIdx = ((sortDepths[i] - minDepth) * scale) | 0;
		if(depthIdx >= UINT16_MAX) 
			depthIdx = UINT16_MAX - 1;

		const outIdx = counts[depthIdx]++;
		outIndices[outIdx] = sortIndices[i];
	}

	const endTime = performance.now();

	postMessage({
		type: 'sorted',
		count: sortCount,
		duration: endTime - startTime
	});
}