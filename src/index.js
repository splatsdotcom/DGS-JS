/* index.js
 * 
 * contains the core logic
 */

const CANVAS_RESOLUTION_SCALE = 2;

//TEMP
const PLY_PATH = "output.ply";
const CAMERA_SPEED = 0.1;

//-------------------------//

import MGSModule from './wasm/mgs.js'
const MGS = await MGSModule();

import { mat4, vec3 } from 'gl-matrix';
import Renderer from './renderer.js'

//-------------------------//

export class SplatPlayer extends HTMLElement 
{
	constructor() 
	{
		super();

		this.#canvas = document.createElement('canvas');
		this.#canvas.style.width = '100%';
		this.#canvas.style.height = '100%';
		this.#canvas.style.display = 'block';
		this.attachShadow({ mode: 'open' }).appendChild(this.#canvas);
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

		//create renderer:
		//---------------
		this.#renderer = new Renderer(this.#canvas);

		//input handlers:
		//---------------
		window.addEventListener('keydown', (e) => { this.#keys[e.code] = true;  });
		window.addEventListener('keyup',   (e) => { this.#keys[e.code] = false; });

		this.#canvas.addEventListener('mousedown', (e) => {
			this.#isDragging = true;
			this.#lastMouse = [e.clientX, e.clientY];
		});
		window.addEventListener('mouseup', () => { this.#isDragging = false; });
		window.addEventListener('mousemove', (e) => {
			if(this.#isDragging) {
				const dx = e.clientX - this.#lastMouse[0];
				const dy = e.clientY - this.#lastMouse[1];
				this.#lastMouse = [e.clientX, e.clientY];

				const sensitivity = 0.0025;
				this.#camYaw   += dx * sensitivity;
				this.#camPitch += dy * sensitivity;
				this.#camPitch = Math.max(-Math.PI/2+0.01, Math.min(Math.PI/2-0.01, this.#camPitch));
			}
		});

		//initialize gaussians:
		//---------------
		const fetchResponse = await fetch(PLY_PATH);
		if(!fetchResponse.ok)
			throw new Error("Failed to fetch test .ply");

		const plyBuf = await fetchResponse.arrayBuffer()

		const loadStartTime = performance.now();

		this.#gaussians = MGS.loadPly(plyBuf)

		const loadEndTime = performance.now();
		console.log(`PLY loading took ${loadEndTime - loadStartTime}ms`);

		const uploadStartTime = performance.now();

		this.#renderer.setGaussians(this.#gaussians);

		const uploadEndTime = performance.now();
		console.log(`GPU upload took ${uploadEndTime - uploadStartTime}ms`);

		//begin main loop:
		//---------------
		requestAnimationFrame((t) => {
			this.#mainLoop(t)
		});
	}

	//-------------------------//

	#canvas = null;
	#renderer = null;
	#gaussians = null;
	#lastRenderTime = null;

	//TEMP: we need a proper camera system!
	#camPos     = vec3.zero(vec3.create());
	#camYaw   = 0.0;
	#camPitch = 0.0;
	#keys     = {};
	#isDragging = false;
	#lastMouse = [0, 0];

	//-------------------------//

	#updateCamera(dt)
	{
		const speed = dt * CAMERA_SPEED;
		const forward = vec3.fromValues(
			Math.cos(this.#camPitch) * Math.sin(this.#camYaw),
			Math.sin(this.#camPitch),
			Math.cos(this.#camPitch) * Math.cos(this.#camYaw)
		);
		const right = vec3.fromValues(
			Math.sin(this.#camYaw - Math.PI/2),
			0,
			Math.cos(this.#camYaw - Math.PI/2)
		);

		if(this.#keys["KeyW"]) vec3.scaleAndAdd(this.#camPos, this.#camPos, forward, speed);
		if(this.#keys["KeyS"]) vec3.scaleAndAdd(this.#camPos, this.#camPos, forward, -speed);
		if(this.#keys["KeyA"]) vec3.scaleAndAdd(this.#camPos, this.#camPos, right, speed);
		if(this.#keys["KeyD"]) vec3.scaleAndAdd(this.#camPos, this.#camPos, right, -speed);
		if(this.#keys["Space"])     this.#camPos[1] -= speed;
		if(this.#keys["ShiftLeft"]) this.#camPos[1] += speed;
	}


	#mainLoop(timestamp)
	{
		//update camera:
		//---------------
		timestamp /= 1000.0; //we want dt in seconds

		var dt = 0.0;
		if(this.#lastRenderTime)
			dt = timestamp - this.#lastRenderTime;

		this.#lastRenderTime = timestamp;
		this.#updateCamera(dt);

		//create cam/proj matrices:
		//---------------
		const target = vec3.create();
		target[0] = this.#camPos[0] + Math.cos(this.#camPitch) * Math.sin(this.#camYaw);
		target[1] = this.#camPos[1] + Math.sin(this.#camPitch);
		target[2] = this.#camPos[2] + Math.cos(this.#camPitch) * Math.cos(this.#camYaw);

		const view = mat4.create();
		this.lastView = view;
		mat4.lookAt(view, this.#camPos, target, [0, -1, 0]);

		const proj = mat4.create();
		const fovY = Math.PI / 4;
		const aspect = this.#canvas.width / this.#canvas.height;
		mat4.perspective(proj, fovY, aspect, 0.01, 100);

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
