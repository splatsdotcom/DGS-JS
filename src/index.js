/* index.js
 * 
 * contains the core logic
 */

const CANVAS_RESOLUTION_SCALE = 2;

//-------------------------//

import MGSModule from './wasm/mgs.js'
const MGS = await MGSModule();

import Renderer from './renderer.js'
import { DefaultCamera, PortalCamera } from './camera.js';

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

		//create loading overlay:
		//---------------
		this.#loader = document.createElement('div');
		Object.assign(this.#loader.style, {
			position: 'absolute',
			top: '50%',
			left: '50%',
			transform: 'translate(-50%, -50%)',
			display: 'none',
			flexDirection: 'column',
			alignItems: 'center',
			gap: '8px',
			fontFamily: 'sans-serif',
			color: 'white',
			pointerEvents: 'none' // don’t block input
		});
		root.appendChild(this.#loader);

		//create progress bar container:
		//---------------
		const barContainer = document.createElement('div');
		Object.assign(barContainer.style, {
			width: '300px',
			height: '16px',
			border: '2px solid white',
			borderRadius: '8px',
			overflow: 'hidden',
			background: 'rgba(255,255,255,0.1)'
		});
		this.#loader.appendChild(barContainer);

		//create progress bar fill:
		//---------------
		this.#progress = document.createElement('div');
		Object.assign(this.#progress.style, {
			width: '0%',
			height: '100%',
			background: 'white',
			borderRadius: '8px 0 0 8px',
			transition: 'width 0.1s linear'
		});
		barContainer.appendChild(this.#progress);

		//create progress text:
		//---------------
		this.#percentText = document.createElement('div');
		Object.assign(this.#percentText.style, {
			fontSize: '14px',
			color: 'white',
			textShadow: '0 0 3px black'
		});
		this.#percentText.textContent = '0%';
		this.#loader.appendChild(this.#percentText);
	}

	connectedCallback() 
	{
		//handle window resize:
		//---------------
		this.#resizeObserver = new ResizeObserver(entries => {
			const entry = entries[0];
			const width = entry.contentBoxSize[0].inlineSize * CANVAS_RESOLUTION_SCALE;
			const height = entry.contentBoxSize[0].blockSize * CANVAS_RESOLUTION_SCALE;

			const canvas = entry.target;
			canvas.width = width;
			canvas.height = height;
		});
		this.#resizeObserver.observe(this.#canvas);

		//create renderer + camera:
		//---------------
		this.#renderer = new Renderer(this.#canvas);
		this.#camera = new DefaultCamera();

		this.#camera.attachToCanvas(this.#canvas);

		//load empty gaussians:
		//---------------
		this.#frames = [ new MGS.GaussianGroup() ];

		//begin main loop:
		//---------------
		requestAnimationFrame((t) => {
			this.#mainLoop(t)
		});
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
			this.setPLY(newValue);
			break;
		case 'src-gs':
			this.setGS(newValue);
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

	async setPLY(path)
	{
		this.#frames = [await this.#loadPLY(path)];
		this.#framerate = 1.0;
		this.#curFrame = -1;
	}

	async setGS(path)
	{
		this.#frames = [await this.#loadGS(path)];
		this.#framerate = 1.0;
		this.#curFrame = -1;
	}

	async setSequencePLY(urls, framerate)
	{
		//TODO
		console.error('not implemented');
	}

	async setSequenceGS(urls, framerate)
	{
		this.#loader.style.display = 'flex';

		this.#frames = await this.#loadSequenceGS(urls);
		this.#framerate = framerate;
		this.#curFrame = -1;

		this.#loader.style.display = 'none';
	}

	setCamera(type, options)
	{
		this.#camera.detachFromCanvas();

		if(type === 'default')
			this.#camera = new DefaultCamera(options);
		else if(type === 'window')
			this.#camera = new PortalCamera(options);
		else
		{
			console.warn('Invalid camera provided, defaulting to \'default\'');
			this.#camera = new DefaultCamera();
		}

		this.#camera.attachToCanvas(this.#canvas);
	}

	//TODO: disconnectedCallback

	//-------------------------//

	#loader = null;
	#progress = null;
	#percentText = null;

	#canvas = null;
	#renderer = null;
	#camera = null;
	#resizeObserver = null;

	#frames = [];
	#framerate = 1.0;

	#lastRenderTime = null;
	#videoTime = 0.0;
	#curFrame = 0;

	//-------------------------//

	async #loadGS(path)
	{
		const fetchResponse = await fetch(path);
		if(!fetchResponse.ok)
			throw new Error("Failed to fetch .gs");

		const gsBuf = await fetchResponse.arrayBuffer()

		const group = new MGS.GaussianGroup();
		group.deserialize(gsBuf);
		return group;
	}

	async #loadPLY(path)
	{
		const fetchResponse = await fetch(path);
		if(!fetchResponse.ok)
			throw new Error("Failed to fetch .ply");

		const plyBuf = await fetchResponse.arrayBuffer()
		return MGS.loadPly(plyBuf);
	}

	async #loadSequenceGS(urls)
	{
		let numLoaded = 0;
		frames = new Array(urls.length);

		const promises = Array.from({ length: urls.length }, (_, i) => 
			this.#loadGS(urls[i]).then(frame => {
				frames[i] = frame;
				
				numLoaded++;
				const percent = Math.floor((numLoaded / urls.length) * 100);
				this.#progress.style.width = `${percent}%`;
				this.#percentText.textContent = `${percent}%`;

				return frame;
			})
		);

		await Promise.all(promises);
		return frames;
	}

	#mainLoop(timestamp)
	{
		//update timing:
		//---------------
		timestamp /= 1000.0; //we want dt in seconds

		var dt = 0.0;
		if(this.#lastRenderTime)
			dt = timestamp - this.#lastRenderTime;

		this.#videoTime += dt;
		let frame = Math.round(this.#videoTime * this.#framerate) % this.#frames.length;

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
		this.#renderer.draw(view, proj, timestamp);

		//loop:
		//---------------
		requestAnimationFrame((t) => {
			this.#mainLoop(t)
		});
	}
}

customElements.define('splat-player', SplatPlayer);
