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

		//create container:
		//---------------
		const container = document.createElement('div');
		container.style.position = 'relative';
		container.style.width = '100%';
		container.style.height = '100%';
		container.style.overflow = 'hidden';
		root.appendChild(container);

		//create canvas:
		//---------------
		this.#canvas = document.createElement('canvas');
		Object.assign(this.#canvas.style, {
			width: '100%',
			height: '100%',
			display: 'block',
		});
		container.appendChild(this.#canvas);

		//create debug overlay:
		//---------------
		this.#debugOverlay = document.createElement('div');
		Object.assign(this.#debugOverlay.style, {
			position: 'absolute',
			top: '8px',
			left: '8px',
			color: 'white',
			background: 'rgba(0,0,0,0.4)',
			padding: '4px 8px',
			fontFamily: 'monospace',
			fontSize: '12px',
			borderRadius: '4px',
			backdropFilter: 'blur(6px)',
			whiteSpace: 'pre',
			pointerEvents: 'none',
			userSelect: 'none'
		});
		container.appendChild(this.#debugOverlay);

		//create controls container:
		//---------------
		const controls = document.createElement('div');
		Object.assign(controls.style, {
			position: 'absolute',
			bottom: '10px',
			left: '50%',
			transform: 'translateX(-50%)',
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			gap: '10px',
			background: 'rgba(0, 0, 0, 0.4)',
			padding: '6px 12px',
			borderRadius: '8px',
			backdropFilter: 'blur(6px)',
			boxSizing: 'border-box',
			width: 'calc(100% - 20px)',
			maxWidth: '600px',
			flexWrap: 'wrap',
		});
		container.appendChild(controls);

		//create play button:
		//---------------
		this.#playPauseBtn = document.createElement('button');
		this.#playPauseBtn.type = 'button';
		this.#playPauseBtn.textContent = '⏸️';
		Object.assign(this.#playPauseBtn.style, {
			border: 'none',
			background: 'transparent',
			color: 'white',
			fontSize: '24px',
			cursor: 'pointer',
			padding: '4px',
			flexShrink: '0',
		});
		this.#playPauseBtn.addEventListener('click', () => {
			this.#playing = !this.#playing;
			this.#playPauseBtn.textContent = this.#playing ? '⏸️' : '▶️';
		});
		controls.appendChild(this.#playPauseBtn);

		//create scrubber:
		//---------------
		this.#scrubber = document.createElement('input');
		this.#scrubber.type = 'range';
		this.#scrubber.min = 0;
		this.#scrubber.step = 0.001; //milliseconds
		this.#scrubber.value = 0;
		Object.assign(this.#scrubber.style, {
			flex: '1 1 auto',
			minWidth: '120px',
			maxWidth: '100%',
			cursor: 'pointer',
			accentColor: '#fff',
		});

		this.#isScrubbing = false;

		this.#scrubber.addEventListener('input', (e) => {
			const t = parseFloat(this.#scrubber.value);
			this.#videoTime = t;

			let frameIndex = Math.floor(t / this.#timePerFrame);
			frameIndex = Math.max(0, Math.min(this.#frames.length - 1, frameIndex));

			if(this.#frames[frameIndex]) 
				this.#renderer.setGaussians(this.#frames[frameIndex]);
			this.#curFrame = frameIndex;
		});

		this.#scrubber.addEventListener('pointerdown', () => {
			this.#isScrubbing = true;
		});

		this.#scrubber.addEventListener('pointerup', (e) => {
			this.#isScrubbing = false;
			const t = parseFloat(this.#scrubber.value);
			this.#videoTime = t;
			const frame = Math.floor(this.#videoTime / this.#timePerFrame);
			this.#curFrame = Math.max(0, Math.min(this.#frames.length - 1, frame));
			if (this.#frames[this.#curFrame])
				this.#renderer.setGaussians(this.#frames[this.#curFrame]);
		});

		controls.appendChild(this.#scrubber);
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
		this.#updateScrubberRange();

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
			'camera',
			'debug'
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
		case 'debug':
		{
			this.#debug = newValue === 'on' ? true : false;
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
		this.#videoTime = 0.0;

		this.#updateScrubberRange();
	}

	setGS(buf)
	{
		this.#frames = [ new MGS.Gaussians(buf) ];
		this.#timePerFrame = 1.0;
		this.#curFrame = -1;
		this.#videoTime = 0.0;

		this.#updateScrubberRange();
	}

	setSequencePLY(bufs, timePerFrame)
	{
		if(timePerFrame === undefined)
			throw new Error('Must providea a framerate to setSequencePLY');

		this.#frames = bufs.map(b => MGS.loadPly(b));
		this.#timePerFrame = timePerFrame;
		this.#curFrame = -1;
		this.#videoTime = 0.0;

		this.#updateScrubberRange();
	}

	setSequenceGS(bufs, timePerFrame)
	{
		if(timePerFrame === undefined)
			throw new Error('Must providea a framerate to setSequenceGS');

		this.#frames = bufs.map(b => new MGS.Gaussians(b));
		this.#timePerFrame = timePerFrame;
		this.#curFrame = -1;
		this.#videoTime = 0.0;

		this.#updateScrubberRange();
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

	#debug = false;

	#frames = [];
	#timePerFrame = 1.0;

	#lastRenderTime = null;
	#videoTime = 0.0;
	#curFrame = 0;
	#isScrubbing = false;
	#playing = true;

	#playPauseBtn = null;
	#scrubber = null;
	#debugOverlay = null;

	//-------------------------//

	#mainLoop(timestamp)
	{
		//update timing:
		//---------------
		timestamp /= 1000.0; //we want dt in seconds

		var dt = 0.0;
		if(this.#lastRenderTime)
			dt = timestamp - this.#lastRenderTime;

		if(this.#playing && !this.#isScrubbing)
			this.#videoTime += dt;

		const duration = this.#frames.length * this.#timePerFrame;
		this.#videoTime %= duration;

		let frameIndex = Math.floor(this.#videoTime / this.#timePerFrame);
		frameIndex = Math.max(0, Math.min(this.#frames.length - 1, frameIndex));
		
		let frameLocalTime = (this.#videoTime % this.#timePerFrame) / this.#timePerFrame;
		frameLocalTime = Math.max(0.0, Math.min(1.0, frameLocalTime));

		if(frameIndex !== this.#curFrame) 
		{
			this.#renderer.setGaussians(this.#frames[frameIndex]);
			this.#curFrame = frameIndex;
		}

		//update scrubber:
		//---------------
		if(!this.#isScrubbing && this.#scrubber) 
			this.#scrubber.value = this.#videoTime;

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
		const profile = this.#renderer.draw(view, proj, frameLocalTime, this.#debug);

		//update profiling display:
		//---------------
		if(profile) 
		{
			this.#debugOverlay.style.opacity = '1';
			this.#debugOverlay.textContent = 
				`Preprocess: ${profile.preprocessTime.toFixed(2)} ms\n` +
				`Sort:       ${profile.sortTime.toFixed(2)} ms\n` +
				`Raster:     ${profile.rasterTime.toFixed(2)} ms\n` +
				`Total:      ${profile.totalTime.toFixed(2)} ms`;
		}
		else
			this.#debugOverlay.style.opacity = '0';

		//loop:
		//---------------
		requestAnimationFrame((t) => {
			this.#mainLoop(t)
		});
	}

	#updateScrubberRange()
	{
		if(!this.#scrubber) 
			return;

		this.#scrubber.min = 0;
		this.#scrubber.max = this.#frames.length * this.#timePerFrame - 0.001;
		this.#scrubber.value = 0;
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
