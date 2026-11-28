SHOW_ALL=false;
include </home/songsenand/Project/ToyMarker/examples/ice-castle-winder/scad/icecastle.scad>
base_mid;
datum_plane("中框顶面",[0,0,34],[0,0,1]);
datum_plane("中框底面",[0,0,20],[0,0,1]);
datum_axis("曲柄轴",[0,-17.3,27],[1,0,0]);
datum("轴承外端",[106,-17.3,27]);
