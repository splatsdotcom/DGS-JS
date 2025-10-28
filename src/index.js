/* index.js
 * 
 * contains the core logic
 */

const CANVAS_RESOLUTION_SCALE = 2;

//-------------------------//

import MGSModule from './wasm/mgs.js'
const MGS = await MGSModule();

import Renderer from './renderer.js'
import { DefaultCamera, SnapCamera, PortalCamera } from './camera.js';

//-------------------------//

export class SplatPlayer extends HTMLElement 
{
	constructor() 
	{
		super();

		const root = this.attachShadow({ mode: 'open' });

		//create canvas:
		//---------------
		this.#canvas = document.createElement('canvas');
		this.#canvas.style.width = '100%';
		this.#canvas.style.height = '100%';
		this.#canvas.style.display = 'block';
		root.appendChild(this.#canvas);
	}

	connectedCallback() 
	{
		//create renderer + camera:
		//---------------
		this.#renderer = new Renderer(this.#canvas);
		this.#camera = new DefaultCamera();

		this.#camera.attachToCanvas(this.#canvas);

		//handle window resize:
		//---------------
		this.#resizeObserver = new ResizeObserver(entries => {
			const entry = entries[0];
			const width = entry.contentBoxSize[0].inlineSize * CANVAS_RESOLUTION_SCALE;
			const height = entry.contentBoxSize[0].blockSize * CANVAS_RESOLUTION_SCALE;

			const canvas = entry.target;
			canvas.width = width;
			canvas.height = height;

			this.#renderer.resize();
		});
		this.#resizeObserver.observe(this.#canvas);

		//load empty gaussians:
		//---------------
		this.#frames = [ new MGS.Gaussians() ];

		//begin main loop:
		//---------------
		requestAnimationFrame((t) => {
			this.#mainLoop(t)
		});
	}

	disconnectedCallback()
	{
		this.#camera.detachFromCanvas();
		this.#resizeObserver.disconnect();
	}

	static get observedAttributes()
	{
		return [
			'src-ply',
			'src-gs', 
			'camera'
		];
	}

	attributeChangedCallback(name, oldValue, newValue)
	{
		if(oldValue == newValue)
			return;

		switch(name)
		{
		case 'src-ply':
			this.#fetchBuf(newValue).then((buf) => {
				this.setPLY(buf);
			})
			break;
		case 'src-gs':
			this.#fetchBuf(newValue).then((buf) => {
				this.setGS(buf);
			})
			break;
		case 'camera':
		{
			let type = 'default';
			let params = {};
			try 
			{
				params = JSON.parse(newValue);
				type = params.type;
			} 
			catch (e) 
			{
				console.warn("Invalid JSON for 'camera' attribute, must be a JSON object containing a 'type' attribute");
			}

			this.setCamera(type, params);
			break;
		}
		default:
			break;
		}
	}

	setPLY(buf)
	{
		this.#frames = [ MGS.loadPly(buf) ];
		this.#timePerFrame = 1.0;
		this.#curFrame = -1;
	}

	setGS(buf)
	{
		this.#frames = [ new MGS.Gaussians(buf) ];
		this.#timePerFrame = 1.0;
		this.#curFrame = -1;
	}

	setSequencePLY(bufs, timePerFrame)
	{
		if(timePerFrame === undefined)
			throw new Error('Must providea a framerate to setSequencePLY');

		this.#frames = bufs.map(b => MGS.loadPly(b));
		this.#timePerFrame = timePerFrame;
		this.#curFrame = -1;
	}

	setSequenceGS(bufs, timePerFrame)
	{
		if(timePerFrame === undefined)
			throw new Error('Must providea a framerate to setSequenceGS');

		this.#frames = bufs.map(b => new MGS.Gaussians(b));
		this.#timePerFrame = timePerFrame;
		this.#curFrame = -1;
	}

	setCamera(type, options)
	{
		this.#camera.detachFromCanvas();

		if(type === 'default')
			this.#camera = new DefaultCamera(options);
		else if(type === 'snap')
			this.#camera = new SnapCamera(options);
		else if(type === 'window')
			this.#camera = new PortalCamera(options);
		else
		{
			console.warn('Invalid camera provided, defaulting to \'default\'');
			this.#camera = new DefaultCamera();
		}

		this.#camera.attachToCanvas(this.#canvas);
	}

	setBackgroundColor(color)
	{
		this.#renderer.setBackgroundColor(color);
	}

	//-------------------------//

	#canvas = null;
	#renderer = null;
	#camera = null;
	#resizeObserver = null;

	#frames = [];
	#timePerFrame = 1.0;

	#lastRenderTime = null;
	#videoTime = 0.0;
	#curFrame = 0;

	//-------------------------//

	#mainLoop(timestamp)
	{
		//update timing:
		//---------------
		timestamp /= 1000.0; //we want dt in seconds

		var dt = 0.0;
		if(this.#lastRenderTime)
			dt = timestamp - this.#lastRenderTime;

		this.#videoTime += dt;

		let frameUnbounded = Math.round(this.#videoTime / this.#timePerFrame);
		let frame = frameUnbounded % this.#frames.length;

		if(frame !== this.#curFrame)
		{
			this.#renderer.setGaussians(this.#frames[frame]);
			this.#curFrame = frame;
		}

		//update camera:
		//---------------
		this.#lastRenderTime = timestamp;
		this.#camera.update(dt * 1000.0);

		//create cam/proj matrices:
		//---------------
		const view = this.#camera.getViewMatrix(this.#canvas.width / this.#canvas.height);
		const proj = this.#camera.getProjMatrix(this.#canvas.width / this.#canvas.height);

		//render:
		//---------------
		this.#renderer.draw(view, proj, this.#videoTime % this.#timePerFrame);

		//loop:
		//---------------
		requestAnimationFrame((t) => {
			this.#mainLoop(t)
		});
	}

	async #fetchBuf(url)
	{
		const response = await fetch(url);
		if(!response.ok)
			throw new Error("Failed to fetch buffer at " + url);

		return await response.arrayBuffer();
	}
}

customElements.define('splat-player', SplatPlayer);
