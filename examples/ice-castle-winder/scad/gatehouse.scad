SHOW_ALL=false;
include </home/songsenand/Project/ToyMarker/examples/ice-castle-winder/scad/icecastle.scad>
gatehouse();
datum("底",[0,-87.5,38]);
datum("门前",[0,-95,48]);
datum_plane("前面",[0,-95,48],[0,-1,0]);
