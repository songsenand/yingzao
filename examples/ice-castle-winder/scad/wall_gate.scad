SHOW_ALL=false;
include </home/songsenand/Project/ToyMarker/examples/ice-castle-winder/scad/icecastle.scad>
wall(true);
datum("舌底",[0,0,-2]);
datum("身底",[0,0,0]);
datum("顶",[0,0,28]);
datum_plane("外面",[2,0,10],[1,0,0]);
datum("门槛",[0,0,0]);
