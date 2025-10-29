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
			flex: '1 1 auto', // responsive width
			minWidth: '120px',
			maxWidth: '100%',
			cursor: 'pointer',
			accentColor: '#fff',
		});

		this.#isScrubbing = false;

		this.#scrubber.addEventListener('input', (e) => {
			const t = parseFloat(this.#scrubber.value);
			this.#videoTime = t;

			let frameIndex;
			if(t < this.#frames.length * this.#timePerFrame)
				frameIndex = Math.floor(t / this.#timePerFrame);
			else 
			{
				const tBack = t - this.#frames.length * this.#timePerFrame;
				frameIndex = this.#frames.length - 1 - Math.floor(tBack / this.#timePerFrame);
			}
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

	#frames = [];
	#timePerFrame = 1.0;

	#lastRenderTime = null;
	#videoTime = 0.0;
	#curFrame = 0;
	#logicalDuration = 0.0;

	#isScrubbing = false;
	#playing = true;
	#playPauseBtn = null;
	#scrubber = null;

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
		{
			this.#videoTime += dt;
			if (this.#videoTime >= this.#logicalDuration)
				this.#videoTime -= this.#logicalDuration; // loop back to start
		}

		const frameCount = this.#frames.length;
		const halfDuration = frameCount * this.#timePerFrame;

		let frameIndex, frameLocalTime;

		if(this.#videoTime < halfDuration) 
		{
			frameIndex = Math.floor(this.#videoTime / this.#timePerFrame);
			frameLocalTime = (this.#videoTime % this.#timePerFrame) / this.#timePerFrame;
		}
		else
		{
			const tBack = this.#videoTime - halfDuration;
			frameIndex = frameCount - 1 - Math.floor(tBack / this.#timePerFrame);
			frameLocalTime = 1 - ((tBack % this.#timePerFrame) / this.#timePerFrame);
		}

		frameIndex = Math.max(0, Math.min(frameCount - 1, frameIndex));
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
		this.#renderer.draw(view, proj, frameLocalTime);

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

		this.#logicalDuration = this.#frames.length * this.#timePerFrame * 2;

		this.#scrubber.min = 0;
		this.#scrubber.max = this.#logicalDuration - 0.001;
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
