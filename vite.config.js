import { defineConfig } from "vite";
import string from 'vite-plugin-string';

export default defineConfig({
	root: "test",
  	plugins: [
		string({ compress: false })
	],
	server: {
		port: 3000,
		headers: {
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Embedder-Policy": "require-corp",
		},
	},
});