/* index.js
 * 
 * contains the core logic
 */

import { DGS } from './context.js';
import Renderer from './renderer.js'
import { DefaultCamera, SnapCamera, PortalCamera } from './camera.js';

//-------------------------//

export class DGSPlayer extends HTMLElement 
{
	constructor() 
	{
		super();

		const root = this.attachShadow({ mode: 'open' });

		//load WASM module:
		//---------------
		DGS.then((dgs) => {
			this.#dgs = dgs;
			this.#readyResolve();
		});

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
			display: 'none',
			top: '1%',
			left: '1%',
			background: 'rgba(0,0,0,0.4)',
			padding: '8px 8px',
			borderRadius: '8px',
			backdropFilter: 'blur(6px)',
			pointerEvents: 'auto',
			userSelect: 'none'
		});
		container.appendChild(this.#debugOverlay);

		this.#debugOverlayText = document.createElement('div');
		Object.assign(this.#debugOverlayText.style, {
			display: 'block',
			color: 'white',
			fontFamily: 'monospace',
			fontSize: '12px',
			whiteSpace: 'pre',
			marginBottom: '10px',
		});
		this.#debugOverlay.appendChild(this.#debugOverlayText);

		const cameraToggle = document.createElement('div');
		cameraToggle.textContent = 'Show Camera Params ▼';
		Object.assign(cameraToggle.style, {
			display: 'block',
			cursor: 'pointer',
			color: 'white',
			fontFamily: 'monospace',
			fontSize: '12px'
		});
		this.#debugOverlay.appendChild(cameraToggle);

		this.#debugOverlayCameraJSON = document.createElement('pre');
		Object.assign(this.#debugOverlayCameraJSON.style, {
			display: 'none',
			color: 'white',
			fontFamily: 'monospace',
			fontSize: '12px',
			whiteSpace: 'pre',
		});
		this.#debugOverlay.appendChild(this.#debugOverlayCameraJSON);

		cameraToggle.addEventListener('click', () => {
			if(this.#debugOverlayCameraJSON.style.display === 'none') 
			{
				this.#debugOverlayCameraJSON.style.display = 'block';
				cameraToggle.textContent = 'Hide Camera Params ▲';
			} 
			else 
			{
				this.#debugOverlayCameraJSON.style.display = 'none';
				cameraToggle.textContent = 'Show Camera Params ▼';
			}
		});

		this.#debugOverlayCameraJSON.addEventListener('click', async () => {
			try 
			{
				await navigator.clipboard.writeText(this.#debugOverlayCameraJSON.textContent);

				const oldBg = this.#debugOverlayCameraJSON.style.color;
				this.#debugOverlayCameraJSON.style.color = 'rgba(255,255,255,0.2)';
				setTimeout(() => {
					this.#debugOverlayCameraJSON.style.color = oldBg || 'transparent';
				}, 200);
			} 
			catch (err) 
			{
				console.error('Failed to copy camera JSON:', err);
			}
		});

		//create controls container:
		//---------------
		this.#controlsOverlay = document.createElement('div');
		Object.assign(this.#controlsOverlay.style, {
			position: 'absolute',
			bottom: '1%',
			left: '50%',
			transform: 'translateX(-50%)',
			display: 'none',
			alignItems: 'center',
			justifyContent: 'center',
			gap: '8px',
			background: 'rgba(0, 0, 0, 0.4)',
			padding: '8px 8px',
			borderRadius: '8px',
			backdropFilter: 'blur(6px)',
			boxSizing: 'border-box',
			width: '50%',
			flexWrap: 'wrap',
		});
		container.appendChild(this.#controlsOverlay);

		//create play button:
		//---------------
		this.#playPauseBtn = document.createElement('button');
		this.#playPauseBtn.type = 'button';
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
			if(this.#segments.length == 1 && this.#curTime >= this.#segments[0].metadata.duration)
				this.#curTime = 0.0;
		});
		this.#controlsOverlay.appendChild(this.#playPauseBtn);

		//create scrubber:
		//---------------
		this.#scrubber = document.createElement('input');
		this.#scrubber.type = 'range';
		this.#scrubber.min = 0;
		this.#scrubber.max = 1;
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

		this.#scrubber.addEventListener('input', () => {
			this.#curTime = parseFloat(this.#scrubber.value);
		});

		this.#scrubber.addEventListener('pointerdown', () => {
			this.#isScrubbing = true;
		});

		this.#scrubber.addEventListener('pointerup', () => {
			this.#isScrubbing = false;
		});

		this.#controlsOverlay.appendChild(this.#scrubber);

		//create renderer + camera:
		//---------------
		this.#renderer = new Renderer(this.#canvas);
		this.#camera = new DefaultCamera();
	}

	connectedCallback() 
	{
		//start getting input from canvas:
		//---------------
		this.#camera.attachToCanvas(this.#canvas);

		//handle window resize:
		//---------------
		this.#resizeObserver = new ResizeObserver(entries => {
			const entry = entries[0];
			const width = Math.round(entry.contentBoxSize[0].inlineSize * window.devicePixelRatio);
			const height = Math.round(entry.contentBoxSize[0].blockSize * window.devicePixelRatio);

			const canvas = entry.target;
			canvas.width = width;
			canvas.height = height;

			this.#renderer.resize();
		});

		//clear segments:
		//---------------
		this.clear();

		//begin main loop:
		//---------------
		this.#renderer.initialize().then(() => {
			this.#resizeObserver.observe(this.#canvas);
			requestAnimationFrame((t) => {
				this.#mainLoop(t)
			});	
		})
	}

	disconnectedCallback()
	{
		this.#camera.detachFromCanvas();
		this.#resizeObserver.disconnect();
	}
 
	static get observedAttributes()
	{
		return [
			'src', 'scene',
			'camera', 'background-color',
			'loop', 'autoplay', 'controls', 
			'point-size', 'time-scale', 'debug'
		];
	}

	attributeChangedCallback(name, oldValue, newValue)
	{
		if(oldValue === newValue)
			return;

		switch(name)
		{
		case 'src':
		{
			if(newValue == null)
				this.#setSrc(null);
			else
			{
				this.#fetchBuf(newValue).then((buf) => {
					this.#enqueueCall(() => {
						if(newValue.endsWith('.ply'))
							this.#setSrc(this.#loadPly(buf));
						else
							this.#setSrc(this.#decode(buf));
					});
				});
			}

			break;
		}
		case 'scene':
		{
			if(newValue == null)
				this.#setScene(null);
			else
			{
				this.#fetchBuf(newValue).then((buf) => {
					this.#enqueueCall(() => {
						if(newValue.endsWith('.ply'))
							this.#setScene(this.#loadPly(buf));
						else
							this.#setScene(this.#decode(buf));

						this.#forceSegmentUpdate = true;
					});
				});
			}

			break;
		}
		case 'camera':
		{
			let type = 'default';
			let params = {};
			try 
			{
				params = JSON.parse(newValue);
				type = params.type;
			} 
			catch(e) { }

			this.setCamera(type, params);
			break;
		}
		case 'background-color':
		{
			try
			{
				const arr = this.getAttribute('background-color').split(' ').map((x) => Number(x) / 255.0);
				if(arr.length === 3)
					this.#renderParams.backgroundColor = arr;
			}
			catch(e) { }

			break;
		}
		case 'loop':
			this.#loop = this.hasAttribute('loop');
			break;
		case 'autoplay':
			this.#autoplay = this.hasAttribute('autoplay');
			break;
		case 'controls':
			this.#controls = this.hasAttribute('controls');
			break;
		case 'time-scale':
			try
			{
				this.#timeScale = Number(this.getAttribute('time-scale'));
			}
			catch(e) { }
			break;
		case 'point-size':
			this.#renderer.setPointSize(newValue);
			break;
		case 'debug':
			this.#debug = this.hasAttribute('debug');
			break;
		default:
			break;
		}
	}

	play()
	{
		this.#playing = true;
	}

	pause()
	{
		this.#playing = false;
	}

	enqueue(buf)
	{
		//TODO: if decoding becomes expensive, we may need to run this on a background thread?

		this.#enqueueCall(() => {
			this.#segments.push(this.#decode(buf));
		});
	}

	clear()
	{
		this.#enqueueCall(() => {
			this.#segments = [{ 
				gaussians: new this.#dgs.Gaussians(),
				metadata: {
					duration: 0.0
				}
			}];	
			this.#forceSegmentUpdate = true;
		})
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

	get paused()
	{
		return !this.#playing;
	}

	get currentTime()
	{
		return this.#curTime;
	}
	
	set currentTime(value)
	{
		const duration = this.#segments[0].metadata.duration;
		if(value < 0.0 || value > duration)
		{
			console.warn('Setting out-of-bounds currentTime');
			return;
		}

		this.#curTime = value;
	}

	get currentSegment()
	{
		return this.#segments[0];
	}

	//-------------------------//

	#dgs = null;

	#canvas = null;
	#renderer = null;
	#camera = null;
	#resizeObserver = null;

	#loop = false;
	#autoplay = false;
	#controls = false;
	#timeScale = 1.0;
	#debug = false;
	#renderParams = {};

	#segments = [];
	#forceSegmentUpdate = false;

	#lastRenderTime = null;
	#curTime = 0.0;
	#isScrubbing = false;
	#playing = false;

	#controlsOverlay = null;
	#playPauseBtn = null;
	#scrubber = null;
	#debugOverlay = null;
	#debugOverlayText = null;
	#debugOverlayCameraJSON = null;

	//-------------------------//

	#mainLoop(renderTime)
	{
		//update timing:
		//---------------
		renderTime /= 1000.0; //we want dt in seconds

		var dt = 0.0;
		if(this.#lastRenderTime)
			dt = renderTime - this.#lastRenderTime;

		if(this.#playing && !this.#isScrubbing)
			this.#curTime += dt * this.#timeScale;

		//update current segment:
		//---------------
		let segment = this.#segments[0];
		let duration = segment.metadata.duration;
		let segmentUpdated = false;
		while(this.#curTime >= duration && this.#segments.length > 1)
		{
			if(duration > 0.0)
				this.onSegmentEnd?.(false);

			this.#curTime -= duration;
			this.#segments.shift();

			segment = this.#segments[0];
			duration = segment.metadata.duration;
			segmentUpdated = true;
		}

		if(segmentUpdated || this.#forceSegmentUpdate)
		{
			this.#renderer.setGaussians(segment.gaussians);
			this.#forceSegmentUpdate = false;
		}

		if(this.#loop)
			this.#curTime %= (duration > 0.0 ? duration : 1.0);
		else if(this.#curTime > duration)
		{
			if(duration > 0.0)
				this.onSegmentEnd?.(true);

			this.#curTime = duration;
			this.#playing = false;
		}
		
		//update controls overlay:
		//---------------
		const showControls = this.#controls && duration > 0.0;
		Object.assign(this.#controlsOverlay.style, {
			display: showControls ? 'flex' : 'none'
		});

		this.#playPauseBtn.textContent = this.#playing ? '⏸️' : '▶️';

		this.#scrubber.max = duration;
		if(!this.#isScrubbing && this.#scrubber) 
			this.#scrubber.value = this.#curTime;

		//update camera:
		//---------------
		this.#lastRenderTime = renderTime;
		this.#camera.update(dt * 1000.0); // TODO: use seconds everywhere

		//create cam/proj matrices:
		//---------------
		const view = this.#camera.getViewMatrix(this.#canvas.width / this.#canvas.height);
		const proj = this.#camera.getProjMatrix(this.#canvas.width / this.#canvas.height);

		//render:
		//---------------
		const normTime = this.#curTime / (duration > 0.0 ? duration : 1.0);
		this.#renderer.draw(view, proj, normTime, this.#renderParams, this.#debug);

		//update debug display:
		//---------------
		const profile = this.#renderer.performanceProfile;

		Object.assign(this.#debugOverlay.style, {
			display: this.#debug ? 'block' : 'none'
		});
		this.#debugOverlayText.textContent = 
			`Time: ${this.#curTime.toFixed(3)} / ${duration.toFixed(3)} s\n` +
			`Num Gaussians Visible: ${this.#renderer.numGaussiansVisible} / ${this.#renderer.numGaussians}\n\n` +
			`Frame Time: ${this.#formatProfile(profile.totalTime)}\n` +
			`\t- Preprocess: ${this.#formatProfile(profile.preprocessTime)}\n` +
			`\t- Raster:     ${this.#formatProfile(profile.rasterTime)}\n` +
			`Last Sort Time: ${this.#formatProfile(profile.lastSortTime)}`;

		this.#debugOverlayCameraJSON.textContent = JSON.stringify(this.#camera.getParams(), null, 2);

		//loop:
		//---------------
		requestAnimationFrame((t) => {
			this.#mainLoop(t)
		});
	}

	#setSrc(gaussians)
	{
		this.#segments = [ gaussians ];
		this.#curTime = 0.0;
		this.#playing = this.#autoplay;

		this.#forceSegmentUpdate = true;
	}

	#setScene(gaussians)
	{
		this.#renderer.setScene(gaussians.gaussians);
	}

	#decode(buf)
	{
		try
		{
			return this.#dgs.decode(buf);
		}
		catch(e)
		{
			throw new Error('Failed to decode .dgs file, see the above stack trace for details: ' + e);
		}
	}

	#loadPly(buf)
	{
		try
		{
			return this.#dgs.loadPly(buf);
		}
		catch(e)
		{
			throw new Error('Failed to load .ply file, see the above stack trace for details: ' + e);
		}
	}

	async #fetchBuf(url)
	{
		const response = await fetch(url);
		if(!response.ok)
			throw new Error("Failed to fetch buffer at " + url);

		return await response.arrayBuffer();
	}

	#formatProfile(x)
	{
		return (x?.toFixed(2) ?? 'N/A') + ' ms';
	}

	//-------------------------//

	#callQueue = Promise.resolve();
	#readyResolve = null;
	#ready = new Promise((res) => this.#readyResolve = res);

	#enqueueCall(fn)
	{
		this.#callQueue = this.#callQueue.then(async () => {
			await this.#ready;
			return await fn();
		}, err => {
			console.error("Enqueuing call failed: ", err);
			throw err;
		});

		return this.#callQueue;
	}
}

customElements.define('dgs-player', DGSPlayer);
