# DGS-JS
This is the home of the web-based tooling for the **Dynamic Gaussian Splat** (`.dgs`) file format. This repository contains:
- Javascript bindings for encoding/decoding `.dgs` files
- Javascript bindings for `.dgs` file utility functions
- A web-based renderer for `.dgs` files

This library is mainly a wrapper over `DGS`, along with a renderer. See the [DGS repo](github.com/splatsdotcom/DGS) for documentation on the `.dgs` file format itself.

## Installation + Usage
To use `DGS-JS` in your own project, you can install the package on `npm`:
```bash
npm install dgs-js
```
Then, it can be used in your project with a simple:
```js
import 'dgs-js'
```
Here is a full example rendering a single `.dgs` file:
```html
<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<title>DGS Player</title>
	<style>
		html, body
		{
			margin: 0;
			height: 100%;
			background: black;
		}
		dgs-player
		{
			width: 100%;
			height: 100%;
			display: block;
		}
	</style>

	<script type="module">
		import "dgs-player";
	</script>
</head>
<body>
	<dgs-player autoplay loop controls src="example.dgs"></dgs-player>
</body>
</html>
```
`example.dgs` can be found [here](https://github.com/splatsdotcom/DGS-JS/blob/main/test/example.dgs).

## Documentation
Coming soon!

## Building WASM
This project uses WebAssembly (WASM) for more optmized operations. If you wish to contribute to this project, you will need to build the WASM module yourself. To build, you will need the tools:
- `CMake`
- `emscripten`

Then, to build the WASM, you will first need to clone the repository and initialize the submodules:
```bash
git clone git@github.com:splatsdotcom/DGS-JS.git
cd DGS-JS
git submodule update --init --recursive
```
Next, you will need to generate build files using `CMake`:
```
cd src
cd wasm
mkdir build
cd build
emcmake cmake ..
```
This will generate a Makefile on Unix systems, and a Visual Studio project on windows. On Unix, you can run:
```
make
```
This will generate `dgs.js` and copy it to the `src/` directory. This is all you need to start development. On Windows, open the genrated `.sln` file in Visual Studio and build from  there.