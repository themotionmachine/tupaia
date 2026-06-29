import { fileURLToPath, URL } from 'node:url';

export default {
    root: './src',
    // Root-domain deploys (Netlify, or the Cloudflare fmg-map Worker via CF_BUILD=1)
    // must build with base '/'; upstream GitHub Pages keeps '/Fantasy-Map-Generator/'.
    base: process.env.NETLIFY || process.env.CF_BUILD ? '/' : '/Fantasy-Map-Generator/',
    build: {
        outDir: '../dist',
        assetsDir: './',
    },
    publicDir: '../public',
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
        },
    },
}