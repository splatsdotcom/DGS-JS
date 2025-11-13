/* sort_worker.js
 *
 * implements a basic web worker to perform sorting of gaussians
 */

import MGSModule from './wasm/mgs.js'
const MGS = await MGSModule();

self.onmessage = async (e) => {
	const { means, velocities, view, proj, time } = e.data;

	const sorted = MGS.Gaussians.cull_and_sort_from_bufs(means, velocities, view, proj, time);
	postMessage({ type: 'sort', sorted }, [sorted.buffer]);
};

postMessage({ type: 'ready' });