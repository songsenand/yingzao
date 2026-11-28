SHOW_ALL=false;
include </home/songsenand/Project/ToyMarker/examples/ice-castle-winder/scad/icecastle.scad>
base_lower;
datum_plane("下座顶面",[0,0,20],[0,0,1]);
datum("下座底面",[0,0,0]);
datum_axis("中轴",[0,0,0],[0,0,1]);
datum("承压柱顶",[0,0,20]);
