SHOW_ALL=false;
include </home/songsenand/Project/ToyMarker/examples/ice-castle-winder/scad/icecastle.scad>
spring_stack();
datum_axis("中轴",[0,0,0],[0,0,1]);
datum("底",[0,0,0]);
datum("顶",[0,0,5.68]);
