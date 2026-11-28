SHOW_ALL=false;
include </home/songsenand/Project/ToyMarker/examples/ice-castle-winder/scad/icecastle.scad>
turret;
datum_axis("中轴",[0,0,0],[0,0,1]);
datum("榫底",[0,0,-4]);
datum("身底",[0,0,0]);
datum("靠面X",[21,0,10]);
datum("靠面Y",[0,21,10]);
