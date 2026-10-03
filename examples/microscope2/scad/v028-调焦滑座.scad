$fn=64;
// 调焦滑座 v6: 前伸臂定在 z=294..310。
//   下死点 (机械极限 δ=-21, 齿条需求 δ=-16.8): 294-16.8 = 277.2 > 齿轮顶 276
//   上死点 (δ=+18 / 需求 +6.8): 310+12.5 = 322.5 < 抱箍梁底 348
zc=265; p=3.14159265; tt=1.071; ad=1.0; dd=1.25; pa=20;
hroot=(tt+2*dd*tan(pa))/2; htip=(tt-2*ad*tan(pa))/2;
module rack(){
  z0=238; z1=292; yr=15.25; yt=17.5; yb=12;
  pts=[[z0,yb],[z1,yb],[z1,yr]]
    ++ [for(i=[8:-1:-7]) each [
         [zc+i*p+hroot, yr],[zc+i*p+htip, yt],[zc+i*p-htip, yt],[zc+i*p-hroot, yr]]]
    ++ [[z0,yr]];
  translate([5,0,0]) rotate([0,-90,0]) linear_extrude(10) polygon(pts);
}
module body(){
  translate([-15.8,2.2,233]) cube([31.6,5.7,65]);   // 舌板 y2.2..7.9 z233..298
  translate([-6.5,7.9,233])  cube([13,7.35,65]);    // 颈  y7.9..15.25
  translate([-6.5,14.5,294]) cube([13,45.5,16]);    // 前伸臂 z294..310
  translate([-24,40,278])    cube([48,40,32]);      // 抱筒环 z278..310
}
difference(){
  union(){ body(); rack(); }
  translate([0,60,268]) cylinder(d=34.3,h=48);
}
// ---- datum anchors ----
datum("滑座背面",[0,2.2,265]);
datum("齿条节线",[0,16.5,265]);
datum("筒座中心",[0,60,294]);
datum("筒座底面",[0,60,278]);
datum("镜筒轴线点",[0,60,243]);
datum("前伸臂下沿",[0,20,294]);
datum_cyl("抱筒孔",[0,60,294],[0,0,1],17.15);
