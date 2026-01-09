/* context.js
 *
 * initializes the WASM and WebGPU contexts
 */

import DGSModule from './wasm/dgs.js'
export const DGS = DGSModule();

//-------------------------//

const gpu = (typeof navigator !== 'undefined') ? navigator.gpu : null;

export const adapter = gpu?.requestAdapter({
	powerPreference: 'high-performance'
});

export const device = adapter?.then(async (adpt) => {
	if(!adpt) 
		return null;

	const limits = adpt.limits;
	const features = adpt.features;

	const dev = await adpt.requestDevice({
		requiredFeatures: features.has('timestamp-query') ? ['timestamp-query'] : [],
		requiredLimits: {
			maxBufferSize: limits.maxBufferSize,
			maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
			maxStorageBuffersPerShaderStage: limits.maxStorageBuffersPerShaderStage
		},
	});

	dev.lost.then((info) => {
		if (info.reason === 'destroyed') return;
		throw new Error(`WebGPU device was lost with info: ${info.message}`);
	});

	return dev;
});

if(!gpu)
	console.warn('WebGPU not supported, you will be unable to create <dgs-player>');
else if(!adapter || !device)
	throw new Error('WebGPU supported, but failed to create adapter or device!');