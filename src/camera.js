/* camera.js
 *
 * implementation of different camera types
 */

import { mat4, vec3 } from 'gl-matrix';

//-------------------------//

class Camera 
{
	constructor() 
	{
		if(new.target === Camera)
			throw new Error("Cannot instantiate abstract class Camera directly");
		
		this.keysPressed = new Set();

		//default mouse tracking
		this.mouseDown = false;
		this.mouseX = 0;
		this.mouseY = 0;
	}

	getViewMatrix() 
	{
		return null;
	}

	getProjMatrix(aspectRatio)
	{
		const fov = this.fov || 80.0;
		return mat4.perspective(
			mat4.create(),
			fov * Math.PI / 180.0, aspectRatio, 0.01, 100.0
		);
	}

	getParams() 
	{
		return {};
	}

	onMouseDown(event) 
	{
		if(event.button === 0)
			this.mouseDown = true;
	}

	onMouseUp(event) 
	{
		if(event.button === 0)
			this.mouseDown = false;
	}

	onMouseMove(event) 
	{
		this.mouseX = event.clientX;
		this.mouseY = event.clientY;
	}

	onDoubleClick(event) 
	{

	}

	onScroll(deltaY) 
	{

	}

	onTouchStart(event) 
	{
		if(event.touches.length === 1)
			this.mouseDown = true;

		this.mouseX = event.touches[0].clientX;
		this.mouseY = event.touches[0].clientY;
	}

	onTouchEnd(event) 
	{
		if(event.touches.length === 1) 
			this.mouseDown = false;
	}

	onTouchMove(event) 
	{
		this.mouseX = event.touches[0].clientX;
		this.mouseY = event.touches[0].clientY;
	}

	onKeyDown(event) 
	{
		this.keysPressed.add(event.code);
	}

	onKeyUp(event) 
	{
		this.keysPressed.delete(event.code);
	}

	update(deltaTime) 
	{

	}

	getParams()
	{
		return null;
	}

	_editingSomething() 
	{
		const el = document.activeElement;
		return (
		  	el &&
		  	(el.tagName === 'INPUT' ||
			 el.tagName === 'TEXTAREA' ||
			 el.isContentEditable)
		);
	  }

	attachToCanvas(canvas) 
	{
		this._onMouseDown = (e) => this.onMouseDown(e);
		this._onMouseUp = (e) => this.onMouseUp(e);
		this._onMouseMove = (e) => this.onMouseMove(e);
		this._onMouseLeave = (e) => this.onMouseUp(e);
		this._onDoubleClick = (e) => this.onDoubleClick(e);
		this._onWheel = (e) => {
			if(this.onScroll !== Camera.prototype.onScroll)
				e.preventDefault();
			
			this.onScroll(e.deltaY);
		};

		this._onTouchStart = (e) => {
			if(this.onTouchStart != Camera.prototype.onTouchStart)
				e.preventDefault();
			
			this.onTouchStart(e);
		};
		this._onTouchMove = (e) => {
			if(this.onTouchMove != Camera.prototype.onTouchMove)
				e.preventDefault();

			this.onTouchMove(e);
		};
		this._onTouchEnd = (e) => {
			if(this.onTouchEnd != Camera.prototype.onTouchEnd)
				e.preventDefault();

			this.onTouchEnd(e);
		};

		this._onKeyDown = (e) => {
			if(this._editingSomething()) 
				return;

			if(e.code === 'Space')
				e.preventDefault();

			this.onKeyDown(e);
		};
		this._onKeyUp = (e) => {
			if(this._editingSomething()) 
				return;

			if(e.code === 'Space') 
				e.preventDefault();

			this.onKeyUp(e);
		};

		canvas.addEventListener('mousedown', this._onMouseDown);
		canvas.addEventListener('mouseup', this._onMouseUp);
		canvas.addEventListener('mousemove', this._onMouseMove);
		canvas.addEventListener('mouseleave', this._onMouseLeave);
		canvas.addEventListener('dblclick', this._onDoubleClick);
		canvas.addEventListener('wheel', this._onWheel);

		canvas.addEventListener('touchstart', this._onTouchStart);
		canvas.addEventListener('touchmove', this._onTouchMove);
		canvas.addEventListener('touchend', this._onTouchEnd);

		window.addEventListener('keydown', this._onKeyDown);
		window.addEventListener('keyup', this._onKeyUp);

		this._canvas = canvas;
	}

	detachFromCanvas() 
	{
		if(!this._canvas)
			return;

		this._canvas.removeEventListener('mousedown', this._onMouseDown);
		this._canvas.removeEventListener('mouseup', this._onMouseUp);
		this._canvas.removeEventListener('mousemove', this._onMouseMove);
		this._canvas.removeEventListener('mouseleave', this._onMouseLeave);
		this._canvas.removeEventListener('dblclick', this._onDoubleClick);
		this._canvas.removeEventListener('wheel', this._onWheel);

		this._canvas.removeEventListener('touchstart', this._onTouchStart);
		this._canvas.removeEventListener('touchmove', this._onTouchMove);
		this._canvas.removeEventListener('touchend', this._onTouchEnd);

		window.removeEventListener('keydown', this._onKeyDown);
		window.removeEventListener('keyup', this._onKeyUp);

		this._canvas = null;
	}
}

//-------------------------//

export class DefaultCamera extends Camera 
{
	constructor(options = {}) 
	{
		super();

		this.fov = options.fov || 80.0;
		
		this.sens = options.sens || 0.003;
		this.panSens = options.panSens || 0.0025;
		this.scrollSens = options.scrollSens || 0.0025;
		this.keyMoveSpeed = options.keyMoveSpeed || 0.02;

		this.minRadius = options.minRadius || 0.5;
		this.maxRadius = options.maxRadius || 3.0;

		this.targetRadius = options.radius || (this.minRadius + this.maxRadius) / 2;
		this.radius = this.targetRadius;

		this.targetTheta = options.theta || 0.0;
		this.theta = this.targetTheta;

		this.targetPhi = options.phi || 0.0;
		this.phi = this.targetPhi;
		
		this.targetPos = vec3.fromValues(
			options.targetX || 0.0,
			options.targetY || 0.0,
			options.targetZ || 0.0
		)
		this.pos = this.targetPos;
		
		this.mouseX = options.mouseX || 0;
		this.mouseY = options.mouseY || 0;
		this.rotating = options.startRotating || false;
		this.dragging = options.startRotating || false;
		this.pinchStartDistance = 0;
	}

	getViewMatrix() 
	{
		const cameraPos = vec3.fromValues(
			this.pos[0] + this.radius * Math.sin(this.theta) * Math.cos(this.phi),
			this.pos[1] + this.radius * Math.sin(this.phi),
			this.pos[2] + this.radius * Math.cos(this.theta) * Math.cos(this.phi)
		);

		return mat4.lookAt(
			mat4.create(),
			cameraPos, 
			this.pos, 
			vec3.fromValues(0.0, 1.0, 0.0)
		);
	}

	getParams() 
	{
		return {
			fov: this.fov,

			sens: this.sens,
			panSens: this.panSens,
			scrollSens: this.scrollSens,

			radius: this.radius,
			minRadius: this.minRadius,
			maxRadius: this.maxRadius,

			theta: this.theta,
			phi: this.phi,

			targetX: this.pos[0],
			targetY: this.pos[1],
			targetZ: this.pos[2],

			mouseX: this.mouseX,
			mouseY: this.mouseY,
			startRotating: this.rotating || this.dragging
		};
	}

	onMouseDown(event) 
	{
		if(event.button === 0)
			this.rotating = true;
		else
			return;

		this.mouseX = event.clientX;
		this.mouseY = event.clientY;
	}

	onMouseUp(event) 
	{
		this.rotating = false;
	}

	onDoubleClick(event) 
	{
		this.targetRadius /= 2.0;
	}

	onMouseMove(event) 
	{
		if(this.rotating) 
		{
			const deltaX = event.clientX - this.mouseX;
			const deltaY = event.clientY - this.mouseY;

			this.targetTheta += deltaX * this.sens;
			this.targetPhi -= deltaY * this.sens;

			this.targetPhi = Math.max(this.targetPhi, -Math.PI / 2 + 0.01);
			this.targetPhi = Math.min(this.targetPhi,  Math.PI / 2 - 0.01);
		} 

		this.mouseX = event.clientX;
		this.mouseY = event.clientY;
	}

	onScroll(deltaY) 
	{
		this.targetRadius += deltaY * this.scrollSens;
		this.targetRadius = Math.max(this.targetRadius, this.minRadius);
		this.targetRadius = Math.min(this.targetRadius, this.maxRadius);
	}

	onTouchStart(event) 
	{
		if(event.touches.length === 1) 
		{
			this.mouseX = event.touches[0].clientX;
			this.mouseY = event.touches[0].clientY;
			this.dragging = true;
		} 
		else if(event.touches.length === 2)
		{
			this.dragging = false;
			const touch1 = event.touches[0];
			const touch2 = event.touches[1];
			this.pinchStartDistance = Math.hypot(
				touch2.clientX - touch1.clientX,
				touch2.clientY - touch1.clientY
			);
		}
	}

	onTouchMove(event)
	{
		if(event.touches.length === 1 && this.dragging) 
		{
			const touch = event.touches[0];
			const deltaX = touch.clientX - this.mouseX;
			const deltaY = touch.clientY - this.mouseY;
			
			this.targetTheta += deltaX * this.sens;
			this.targetPhi -= deltaY * this.sens;

			this.targetPhi = Math.max(this.targetPhi, -Math.PI / 2);
			this.targetPhi = Math.min(this.targetPhi, Math.PI / 2);

			this.mouseX = touch.clientX;
			this.mouseY = touch.clientY;
		} 
		else if(event.touches.length === 2) 
		{
			const touch1 = event.touches[0];
			const touch2 = event.touches[1];
			const currentDistance = Math.hypot(
				touch2.clientX - touch1.clientX,
				touch2.clientY - touch1.clientY
			);
			
			const deltaDistance = this.pinchStartDistance - currentDistance;
			this.onScroll(deltaDistance);
			
			this.pinchStartDistance = currentDistance;
		}
	}

	onTouchEnd(event) 
	{
		if(event.touches.length === 0)
			this.dragging = false;
		else if(event.touches.length === 1)
		{
			this.mouseX = event.touches[0].clientX;
			this.mouseY = event.touches[0].clientY;
		}
	}

	update(deltaTime) 
	{
		super.update(deltaTime);
		
		const decay = 1.0 - Math.pow(0.99, deltaTime);

		this.pos = vec3.add(
			vec3.create(), this.pos, 
			vec3.scale(
				vec3.create(), vec3.sub(
					vec3.create(), this.targetPos, 
					this.pos
				), 
				decay
			)
		);
		this.radius += (this.targetRadius - this.radius) * decay;
		this.theta += (this.targetTheta - this.theta) * decay;
		this.phi += (this.targetPhi - this.phi) * decay;

		if(this.keysPressed.size > 0)
			this.handleKeyboardMovement(deltaTime);
	}

	handleKeyboardMovement(deltaTime) 
	{
		const moveSpeed = this.keyMoveSpeed * (deltaTime / 16.67);
		
		const rightX = Math.cos(this.targetTheta);
		const rightZ = -Math.sin(this.targetTheta);
		
		const forwardX = -Math.sin(this.targetTheta);
		const forwardZ = -Math.cos(this.targetTheta);
		
		let deltaX = 0;
		let deltaY = 0;
		let deltaZ = 0;
		
		if(this.keysPressed.has('KeyW')) 
		{
			deltaX += forwardX;
			deltaZ += forwardZ;
		}
		if(this.keysPressed.has('KeyS')) 
		{
			deltaX -= forwardX;
			deltaZ -= forwardZ;
		}
		if(this.keysPressed.has('KeyA')) 
		{
			deltaX -= rightX;
			deltaZ -= rightZ;
		}
		if(this.keysPressed.has('KeyD')) 
		{
			deltaX += rightX;
			deltaZ += rightZ;
		}
		if(this.keysPressed.has('Space'))
			deltaY -= 1.0;
		if(this.keysPressed.has('ShiftLeft'))
			deltaY += 1.0;
		
		this.targetPos = vec3.add(
			vec3.create(), this.targetPos,
			vec3.scale(
				vec3.create(), vec3.normalize(
					vec3.create(), vec3.fromValues(deltaX, deltaY, deltaZ)
				), 
				moveSpeed
			)
		);
	}
}

//-------------------------//

export class SnapCamera extends Camera 
{
	constructor(options = {}) 
	{
		super();

		this.fov = options.fov || 80.0;

		this.baseTheta  = options.baseTheta  || Math.PI / 4;
		this.basePhi    = options.basePhi    || Math.PI / 4;

		this.targetTheta  = options.theta  || this.baseTheta;
		this.targetPhi    = options.phi    || this.basePhi;
		this.targetRadius = options.radius || 1.5;

		this.theta  = this.targetTheta;
		this.phi    = this.targetPhi;
		this.radius = this.targetRadius;

		this.minRadius = options.minRadius || 0.5;
		this.maxRadius = options.maxRadius || 3.0;

		this.targetX = options.targetX || 0.0;
		this.targetY = options.targetY || 0.0;
		this.targetZ = options.targetZ || 0.0;

		this.sens = options.sens || 0.003;
		this.scrollSens = options.scrollSens || 0.0025;

		this.resistance = options.resistance || 0.25;
		this.deadZone = options.deadZone || 0.1;
		this.snapSmoothness = options.snapSmoothness || 0.9925;
		this.valueSmoothness = options.valueSmoothness || 0.9925;
		this.radiusSmoothness = options.radiusSmoothness || 0.99;

		this.mouseX = options.mouseX || 0;
		this.mouseY = options.mouseY || 0;
		this.rotating = options.startRotating || false;

		this.pinchStartDistance = 0;
		this.canvas = null;
	}

	attachToCanvas(canvas) 
	{
		super.attachToCanvas(canvas);

		this.canvas = canvas;
	}

	getViewMatrix() 
	{
		const cameraX = this.targetX + this.radius * Math.sin(this.theta) * Math.cos(this.phi);
		const cameraY = this.targetY + this.radius * Math.sin(this.phi);
		const cameraZ = this.targetZ + this.radius * Math.cos(this.theta) * Math.cos(this.phi);

		return mat4.lookAt(
			mat4.create(),
			vec3.fromValues(cameraX, cameraY, cameraZ),
			vec3.fromValues(this.targetX, this.targetY, this.targetZ),
			vec3.fromValues(0.0, 1.0, 0.0)
		);
	}

	onMouseDown(event) 
	{
		if(event.button !== 0) 
			return;

		this.rotating = true;
		this.mouseX = event.clientX;
		this.mouseY = event.clientY;

		this.targetTheta  = this.theta;
		this.targetPhi    = this.phi;
		this.targetRadius = this.radius;
	}

	onMouseUp(event) 
	{
		if(event.button === 0)
			this.rotating = false;
	}

	onMouseMove(event) 
	{
		if(!this.rotating) 
		{
			this.mouseX = event.clientX;
			this.mouseY = event.clientY;
			return;
		}

		const deltaX = event.clientX - this.mouseX;
		const deltaY = event.clientY - this.mouseY;

		const offTheta = this.targetTheta - this.baseTheta;
		const offPhi   = this.targetPhi   - this.basePhi;
		const resistance = this.#angleResistanceFactor(offTheta, offPhi, this.resistance);

		this.targetTheta += deltaX * this.sens * resistance;
		this.targetPhi   -= deltaY * this.sens * resistance;

		this.targetPhi = Math.max(this.targetPhi, -Math.PI / 2 + 0.01);
		this.targetPhi = Math.min(this.targetPhi,  Math.PI / 2 - 0.01);

		this.mouseX = event.clientX;
		this.mouseY = event.clientY;
	}

	onScroll(deltaY) 
	{
		this.targetRadius += deltaY * this.scrollSens;

		this.targetRadius = Math.max(this.targetRadius, this.minRadius);
		this.targetRadius = Math.min(this.targetRadius, this.maxRadius);
	}

	onTouchStart(event) 
	{
		if(event.touches.length === 1) 
		{
			const t = event.touches[0];
			this.rotating = true;
			this.mouseX = t.clientX;
			this.mouseY = t.clientY;
		} 
		else if (event.touches.length === 2) 
		{
			this.rotating = false;
			const t0 = event.touches[0];
			const t1 = event.touches[1];
			this.pinchStartDistance = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
		}
	}

	onTouchMove(event) 
	{
		if(event.touches.length === 1 && this.rotating) 
		{
			const t = event.touches[0];
			const deltaX = t.clientX - this.mouseX;
			const deltaY = t.clientY - this.mouseY;

			const offTheta = this.targetTheta - this.baseTheta;
			const offPhi   = this.targetPhi   - this.basePhi;
			const resistance = this.#angleResistanceFactor(offTheta, offPhi, this.resistance);

			this.targetTheta += deltaX * this.sens * resistance;
			this.targetPhi   -= deltaY * this.sens * resistance;

			this.targetPhi = Math.max(this.targetPhi, -Math.PI / 2 + 0.01);
			this.targetPhi = Math.min(this.targetPhi,  Math.PI / 2 - 0.01);

			this.mouseX = t.clientX;
			this.mouseY = t.clientY;
		}
		else if(event.touches.length === 2) 
		{
			const t0 = event.touches[0];
			const t1 = event.touches[1];
			const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
			const deltaDist = this.pinchStartDistance - dist;
			this.onScroll(deltaDist);
			this.pinchStartDistance = dist;
		}
	}

	onTouchEnd(event) 
	{
		if(event.touches.length === 0)
			this.rotating = false;
		else if (event.touches.length === 1) 
		{
			const t = event.touches[0];
			this.mouseX = t.clientX;
			this.mouseY = t.clientY;
		}
	}

	update(deltaTime) 
	{
		super.update(deltaTime);

		const snapDecay  = 1.0 - Math.pow(this.snapSmoothness,  deltaTime);
		const valueDecay = 1.0 - Math.pow(this.valueSmoothness, deltaTime);

		if(this.rotating) 
		{
			this.theta  = this.targetTheta;
			this.phi    = this.targetPhi;
			this.radius = this.targetRadius;
		}
		else 
		{
			const nearest = this.#closestPointDeadzone(
				this.targetTheta, this.targetPhi,
				this.baseTheta, this.basePhi,
				this.deadZone
			);

			this.targetTheta += (nearest.theta - this.targetTheta) * snapDecay;
			this.targetPhi   += (nearest.phi   - this.targetPhi)   * snapDecay;

			this.theta  += (this.targetTheta  - this.theta)  * valueDecay;
			this.phi    += (this.targetPhi    - this.phi)    * valueDecay;
			this.radius += (this.targetRadius - this.radius) * (1.0 - Math.pow(this.radiusSmoothness, deltaTime));
		}
	}

	#angleResistanceFactor(dTheta, dPhi, scale) 
	{
		const dist = Math.hypot(dTheta, dPhi);
		const x = dist / (1.0 - scale);
		return 1.0 / (1.0 + x * x);
	}

	#closestPointDeadzone(currentTheta, currentPhi, baseTheta, basePhi, deadZone) 
	{
		const dTheta = currentTheta - baseTheta;
		const dPhi   = currentPhi   - basePhi;

		const dist = Math.hypot(dTheta, dPhi);
		if(dist <= deadZone) 
			return { theta: currentTheta, phi: currentPhi };
		else 
		{
			const scale = deadZone / dist;
			return {
				theta: baseTheta + dTheta * scale,
				phi:   basePhi   + dPhi   * scale
			};
		}
	}

	getParams() 
	{
		return {
			viewMat: this.getViewMatrix(),
			fov: this.fov,

			baseTheta: this.baseTheta,
			basePhi: this.basePhi,

			theta: this.theta,
			phi: this.phi,
			radius: this.radius,

			minRadius: this.minRadius,
			maxRadius: this.maxRadius,

			targetX: this.targetX,
			targetY: this.targetY,
			targetZ: this.targetZ,
			
			sens: this.sens,
			scrollSens: this.scrollSens,
			
			resistance: this.resistance,
			deadZone: this.deadZone,
			
			snapSmoothness: this.snapSmoothness,
			valueSmoothness: this.valueSmoothness,
			radiusSmoothness: this.radiusSmoothness,

			startRotating: this.mouseDown,
			mouseX: this.mouseX,
			mouseY: this.mouseY,
		};
	}
}

//-------------------------//

export class PortalCamera extends Camera
{
	constructor(options = {})
	{
		super();

		//set fields:
		//-----------------
		this.screenPos = options.screenPos || [0.0, 0.0, 1.0];
		this.screenTarget = options.screenTarget || [0.0, 0.0, 0.0];
		this.screenScale = options.screenScale || 1.0;

		this.eyePosWorld = options.eyePosWorld || [0.0, 0.0, 1.0];
		this.worldToVoxelScale = options.worldToVoxelScale || 1.0;

		//compute screen transform:
		//-----------------
		this.screenTransform = mat4.invert(
			mat4.create(),
			mat4.lookAt(
				mat4.create(), 
				this.screenPos, 
				this.screenTarget, 
				[0.0, 1.0, 0.0]
			)
		);
	}

	getViewMatrix(aspect)
	{
		return this.#getMatrices(aspect).view;
	}

	getProjMatrix(aspect)
	{
		return this.#getMatrices(aspect).proj;
	}

	//from: https://en.wikibooks.org/wiki/Cg_Programming/Unity/Projection_for_Virtual_Reality
	#getMatrices(aspect) 
	{
		const n = 0.01;
		const f = 100.0;

		//compute screen edges in voxel space:
		//-----------------
		var screenEdgeHorizontal = aspect > 1.0 ? 1.0            : aspect;
		var screenEdgeVertical   = aspect > 1.0 ? (1.0 / aspect) : 1.0;
		screenEdgeHorizontal *= this.screenScale;
		screenEdgeVertical   *= this.screenScale;

		let pa = vec3.transformMat4(vec3.create(), vec3.fromValues(-screenEdgeHorizontal, -screenEdgeVertical, 0.0), this.screenTransform);
		let pb = vec3.transformMat4(vec3.create(), vec3.fromValues( screenEdgeHorizontal, -screenEdgeVertical, 0.0), this.screenTransform);
		let pc = vec3.transformMat4(vec3.create(), vec3.fromValues(-screenEdgeHorizontal,  screenEdgeVertical, 0.0), this.screenTransform);

		let eyePosVoxel = vec3.scale(vec3.create(), this.eyePosWorld, this.worldToVoxelScale);
		eyePosVoxel[1] += screenEdgeVertical;
		eyePosVoxel[2] = Math.max(eyePosVoxel[2], 0.0001); //ensure not touching screen
		
		let pe = vec3.transformMat4(vec3.create(), eyePosVoxel, this.screenTransform);

		//compute frustum:
		//-----------------
		let vr = vec3.sub(vec3.create(), pb, pa);
		let vu = vec3.sub(vec3.create(), pc, pa);
		let va = vec3.sub(vec3.create(), pa, pe);
		let vb = vec3.sub(vec3.create(), pb, pe);
		let vc = vec3.sub(vec3.create(), pc, pe);

		vr = vec3.normalize(vec3.create(), vr);
		vu = vec3.normalize(vec3.create(), vu);
		let vn = vec3.scale(vec3.create(), vec3.cross(vec3.create(), vr, vu), 1.0);

		let d = -vec3.dot(va, vn);
		let l = vec3.dot(vr, va) * n / d;
		let r = vec3.dot(vr, vb) * n / d;
		let b = vec3.dot(vu, va) * n / d;
		let t = vec3.dot(vu, vc) * n / d;

		//construct projection matrix:
		//-----------------
		let p = mat4.create();
		p[4 * 0 + 0] = 2.0 * n / (r - l);
		p[4 * 1 + 0] = 0.0;
		p[4 * 2 + 0] = (r + l) / (r - l);
		p[4 * 3 + 0] = 0.0;

		p[4 * 0 + 1] = 0.0;
		p[4 * 1 + 1] = 2.0 * n / (t - b);
		p[4 * 2 + 1] = (t + b) / (t - b);
		p[4 * 3 + 1] = 0.0;

		p[4 * 0 + 2] = 0.0;
		p[4 * 1 + 2] = 0.0;
		p[4 * 2 + 2] = (f + n) / (n - f);
		p[4 * 3 + 2] = 2.0 * f * n / (n - f);

		p[4 * 0 + 3] = 0.0;
		p[4 * 1 + 3] = 0.0;
		p[4 * 2 + 3] = -1.0;
		p[4 * 3 + 3] = 0.0;

		//construct view matrix:
		//-----------------
		let rm = mat4.create();
		rm[4 * 0 + 0] = vr[0];
		rm[4 * 1 + 0] = vr[1];
		rm[4 * 2 + 0] = vr[2];
		rm[4 * 3 + 0] = 0.0;

		rm[4 * 0 + 1] = vu[0];
		rm[4 * 1 + 1] = vu[1];
		rm[4 * 2 + 1] = vu[2];
		rm[4 * 3 + 1] = 0.0;

		rm[4 * 0 + 2] = vn[0];
		rm[4 * 1 + 2] = vn[1];
		rm[4 * 2 + 2] = vn[2];
		rm[4 * 3 + 2] = 0.0;

		rm[4 * 0 + 3] = 0.0;
		rm[4 * 1 + 3] = 0.0;
		rm[4 * 2 + 3] = 0.0;
		rm[4 * 3 + 3] = 1.0;

		let tm = mat4.translate(
			mat4.create(), mat4.identity(mat4.create()), 
			vec3.scale(vec3.create(), pe, -1.0)
		);

		//return:
		//-----------------
		// console.log(vu);

		return {
			view: mat4.mul(mat4.create(), rm, tm),
			proj: p
		};
	}

	getParams()
	{
		return {
			screenPos: this.screenPos,
			screenTarget: this.screenTarget,
			screenScale: this.screenScale,

			eyePosWorld: this.eyePosWorld,
			worldToVoxelScale: this.worldToVoxelScale,

			startRotating: this.mouseDown,
			mouseX: this.mouseX,
			mouseY: this.mouseY,
		}
	}
}
