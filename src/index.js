/* index.js
 * 
 * contains the core logic
 */

const CANVAS_RESOLUTION_SCALE = 2;

//TEMP
const GS_DIR = "worldlabs";
const GS_FRAME_COUNT = 1;
const GS_FRAMERATE = 30.0;

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
			display: 'flex',
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

	async connectedCallback() 
	{
		//handle window resize:
		//---------------
		let onResize = () => {
			this.#canvas.width  = this.clientWidth  * CANVAS_RESOLUTION_SCALE;
			this.#canvas.height = this.clientHeight * CANVAS_RESOLUTION_SCALE;
		};

		onResize();
		window.addEventListener('resize', onResize);

		//create renderer + camera:
		//---------------
		this.#renderer = new Renderer(this.#canvas);
		this.#camera = new PortalCamera();

		this.#camera.attachToCanvas(this.#canvas);

		//load frames:
		//---------------
		await this.#loadAllFrames();
		this.#loader.style.display = 'none';

		this.#renderer.setGaussians(this.#frames[0]);

		//begin main loop:
		//---------------
		requestAnimationFrame((t) => {
			this.#mainLoop(t)
		});
	}

	//TODO: disconnectedCallback

	//-------------------------//

	async #loadAllFrames() 
	{
		let numLoaded = 0;

		const promises = Array.from({ length: GS_FRAME_COUNT }, (_, i) => 
			this.#loadPly(GS_DIR + `/${i}.ply`).then(frame => {
				this.#frames[i] = frame;
				
				numLoaded++;
				const percent = Math.floor((numLoaded / GS_FRAME_COUNT) * 100);
				this.#progress.style.width = `${percent}%`;
				this.#percentText.textContent = `${percent}%`;

				return frame;
			})
		);

		await Promise.all(promises);
	}

	//-------------------------//

	#loader = null;
	#progress = null;
	#percentText = null;

	#canvas = null;
	#renderer = null;
	#camera = null;
	#frames = [];

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

	async #loadPly(path)
	{
		const fetchResponse = await fetch(path);
		if(!fetchResponse.ok)
			throw new Error("Failed to fetch .ply");

		const plyBuf = await fetchResponse.arrayBuffer()
		return MGS.loadPly(plyBuf);
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
		let frame = Math.round(this.#videoTime * GS_FRAMERATE) % GS_FRAME_COUNT;

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
