/* context.js
 *
 * initializes the WebGPU context
 */

export const GPU_PROFILING = false; //NOTE: set to false before pushing!!!

export const adapter = await navigator.gpu?.requestAdapter();

const limits = adapter?.limits;
export const device = await adapter?.requestDevice({
	requiredFeatures: GPU_PROFILING ? ['timestamp-query'] : [],
	requiredLimits: {
		maxBufferSize: limits?.maxBufferSize,
		maxStorageBufferBindingSize: limits?.maxStorageBufferBindingSize,
		maxStorageBuffersPerShaderStage: limits?.maxStorageBuffersPerShaderStage
	},
});

device?.lost.then((info) => {
	if(info.reason === 'destroyed') //we don't need to log an error if we destroyed the device ourselves
		return;

	throw new Error(`WebGPU device was lost with info: ${info.message}`);
});

if(!navigator.gpu)
	console.warn('WebGPU not supported, you will be unable to create <splv-player> or <vv-player>');
else if(!adapter || !device)
	throw new Error('WebGPU supported, but failed to create adapter or device!');