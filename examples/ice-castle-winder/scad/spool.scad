SHOW_ALL=false;
include </home/songsenand/Project/ToyMarker/examples/ice-castle-winder/scad/icecastle.scad>
spool;
datum_axis("中轴",[0,0,0],[0,0,1]);
datum("底面",[0,0,0]);
datum("顶面",[0,0,18]);
datum("桶面点",[20,0,9]);
