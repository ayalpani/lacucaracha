// Minimal immersive-ar mock: viewer slowly pans over a floor at y=-1.3 and a wall at z=-2.2.
(() => {
  const FLOOR = -1.3, WALL = -2.2;
  const mat = {
    mul(a, b) { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c*4+r] += a[k*4+r] * b[c*4+k]; return o; },
    fromQuatPos(q, p) { const [x,y,z,w]=q; return [1-2*(y*y+z*z),2*(x*y+z*w),2*(x*z-y*w),0, 2*(x*y-z*w),1-2*(x*x+z*z),2*(y*z+x*w),0, 2*(x*z+y*w),2*(y*z-x*w),1-2*(x*x+y*y),0, p[0],p[1],p[2],1]; },
    invRigid(m) { const r=[m[0],m[4],m[8],0, m[1],m[5],m[9],0, m[2],m[6],m[10],0, 0,0,0,1]; const t=[m[12],m[13],m[14]]; r[12]=-(r[0]*t[0]+r[4]*t[1]+r[8]*t[2]); r[13]=-(r[1]*t[0]+r[5]*t[1]+r[9]*t[2]); r[14]=-(r[2]*t[0]+r[6]*t[1]+r[10]*t[2]); return r; },
  };
  const qMul=(a,b)=>[a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1],a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3],a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]];
  const qAxis=(ax,ang)=>{const s=Math.sin(ang/2);return [ax[0]*s,ax[1]*s,ax[2]*s,Math.cos(ang/2)];};
  const rot=(q,v)=>{const m=mat.fromQuatPos(q,[0,0,0]);return [m[0]*v[0]+m[4]*v[1]+m[8]*v[2],m[1]*v[0]+m[5]*v[1]+m[9]*v[2],m[2]*v[0]+m[6]*v[1]+m[10]*v[2]];};
  let viewerQ=[0,0,0,1], viewerP=[0,0,0];
  window.__xrPose = (yaw, pitch, p) => { viewerQ = qMul(qAxis([0,1,0],yaw), qAxis([1,0,0],pitch)); if (p) viewerP = p; };
  window.__xrPose(0, -0.7);
  const tf = (m) => ({ matrix: new Float32Array(m), position: {x:m[12],y:m[13],z:m[14],w:1}, orientation: {x:0,y:0,z:0,w:1}, inverse: { matrix: new Float32Array(mat.invRigid(m)) } });
  const viewerTf = () => { const m = mat.fromQuatPos(viewerQ, viewerP); const t = tf(m); t.orientation = {x:viewerQ[0],y:viewerQ[1],z:viewerQ[2],w:viewerQ[3]}; return t; };
  class Space { constructor(type){this.type=type;} getOffsetReferenceSpace(){return this;} addEventListener(){} }
  window.XRRay = class { constructor(o, d){ this.origin=o; this.direction=d; } };
  window.XRWebGLLayer = class { constructor(s, gl){ this.framebuffer=null; this.framebufferWidth=gl.drawingBufferWidth; this.framebufferHeight=gl.drawingBufferHeight; this.antialias=true; this.ignoreDepthValues=false; } getViewport(){ return {x:0,y:0,width:this.framebufferWidth,height:this.framebufferHeight}; } };
  for (const C of [WebGLRenderingContext, WebGL2RenderingContext]) C.prototype.makeXRCompatible = async function(){};
  const proj = (() => { const f=1/Math.tan(30*Math.PI/180), a=innerWidth/innerHeight, n=0.01, fa=50; return new Float32Array([f/a,0,0,0, 0,f,0,0, 0,0,(fa+n)/(n-fa),-1, 0,0,2*fa*n/(n-fa),0]); })();
  window.__hitCount = 0;
  function hit(src) {
    const d = rot(viewerQ, [src.dir.x, src.dir.y, src.dir.z]); const o = viewerP;
    let best = null;
    if (d[1] < -1e-3) { const t=(FLOOR-o[1])/d[1]; best={t,n:[0,1,0]}; }
    if (d[2] < -1e-3) { const t=(WALL-o[2])/d[2]; if (!best || t<best.t) best={t,n:[0,0,1]}; }
    if (!best || best.t > 6) return [];
    window.__hitCount++;
    const p=[o[0]+d[0]*best.t,o[1]+d[1]*best.t,o[2]+d[2]*best.t];
    const q = best.n[1] ? [0,0,0,1] : qAxis([1,0,0], Math.PI/2);
    const m = mat.fromQuatPos(q, p);
    return [{ getPose(){ return { transform: tf(m) }; } }];
  }
  class Session extends EventTarget {
    constructor(){ super(); this.renderState={baseLayer:null,depthNear:0.1,depthFar:1000,layers:undefined}; this.inputSources=[]; this.environmentBlendMode='alpha-blend'; this.enabledFeatures=['hit-test','dom-overlay']; this.raf=new Map(); this.id=0; }
    updateRenderState(s){ Object.assign(this.renderState, s); }
    async requestReferenceSpace(t){ return new Space(t); }
    async requestHitTestSource({offsetRay}){ return { dir: offsetRay ? offsetRay.direction : {x:0,y:0,z:-1}, cancel(){} }; }
    requestAnimationFrame(cb){ const id=++this.id; const h=requestAnimationFrame((t)=>{ const frame={ session:this, getViewerPose:()=>{ const t2=viewerTf(); return { transform:t2, views:[{ eye:'none', projectionMatrix:proj, transform:t2, recommendedViewportScale:null }] }; }, getHitTestResults:(s)=>hit(s), getPose:()=>({transform:viewerTf()}) }; cb(t, frame); }); this.raf.set(id,h); return id; }
    cancelAnimationFrame(id){ cancelAnimationFrame(this.raf.get(id)); }
    async end(){ this.dispatchEvent(new Event('end')); }
  }
  Object.defineProperty(navigator, 'xr', { value: { isSessionSupported: async () => true, requestSession: async () => new Session(), addEventListener(){} } });
})();
