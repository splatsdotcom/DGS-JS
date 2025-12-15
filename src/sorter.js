/* sorter.js
 *
 * contains the implementation of the gaussian splat sorter
 */

//TODO: optimize with WASM?

//-------------------------//

export default class Sorter
{
	constructor(gaussians, onSorted)
	{
		//init SAB:
		//---------------
		const sabLength = gaussians.means.byteLength + gaussians.velocities.byteLength + gaussians.length * Uint32Array.BYTES_PER_ELEMENT;
		let sab;
		try
		{
			sab = new SharedArrayBuffer(sabLength);
		}
		catch(e)
		{
			throw new Error(
				'SharedArrayBuffer is not available in this environment.\n\n' +
				'This commonly means either:\n' +
				'• Cross-origin isolation is not enabled.\n' +
				'• You are on an unsupported browser'
			);
		}

		const meansOffset = 0;
		const means = new Float32Array(sab, meansOffset, gaussians.means.length);
		means.set(gaussians.means);

		const velocitiesOffset = meansOffset + gaussians.means.byteLength;
		const velocities = new Float32Array(sab, velocitiesOffset, gaussians.velocities.length);
		velocities.set(gaussians.velocities);

		const indicesOffset = velocitiesOffset + gaussians.velocities.byteLength;
		
		//init worker:
		//---------------
		this.#worker = new Worker(
			new URL('./workers/sort.js', import.meta.url),
			{ type: 'module' }
		);
		this.#worker.onmessage = (e) => {
			if(e.data.type !== 'sorted')
				return;

			const indices = new Uint32Array(
				sab, gaussians.means.byteLength + gaussians.velocities.byteLength, e.data.count
			);
			onSorted(indices, e.data.duration);
		};

		this.#worker.postMessage({
			type: 'init',

			count: gaussians.length,
			dynamic: gaussians.dynamic ? true : false,

			sab: sab,
			meansOffset: meansOffset, 
			velocitiesOffset: velocitiesOffset,
			indicesOffset: indicesOffset
		});
	}

	sort(view, proj, time)
	{
		this.#worker.postMessage({
			type: 'sort',
			view: view.slice(),
			proj: proj.slice(),
			time: time
		});
	}

	//-------------------------//

	#worker = null;
}