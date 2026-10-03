$fn=64;
// 载物台 110x90x8, 台面 z=230.13, 底 z=222.13.
// 玻片槽 75.4x25.3x1.5 -> 槽底 228.63; 标本面 = 槽底+1.2(载玻片)+0.17(盖玻片) = 230.00
// 通光孔 Ø12 @ (0,60); 与支架 2xM3; 与照明座 2xM3 铜螺母孔 (x=±45)
TOP=230.13; BOT=222.13; DECK=8;
module rrect(x0,x1,y0,y1,r){
  hull(){
    translate([x0+r,y0+r]) circle(r=r);
    translate([x1-r,y0+r]) circle(r=r);
    translate([x0+r,y1-r]) circle(r=r);
    translate([x1-r,y1-r]) circle(r=r);
  }
}
difference(){
  translate([0,0,BOT]) linear_extrude(DECK) rrect(-55,55,15,105,6);
  translate([-37.7,47.35,228.63]) cube([75.4,25.3,2]);          // 玻片槽
  translate([0,60,BOT-1]) cylinder(d=12,h=DECK+2);              // 通光孔 Ø12
  for(sx=[-1,1]) translate([sx*30,30,BOT-1]) cylinder(d=3.4,h=DECK+2);   // 与支架 M3 通孔
  for(sx=[-1,1]) translate([sx*45,60,BOT]) cylinder(d=4.2,h=5.8);        // 与照明座铜螺母孔
}
// ---- datum anchors ----
datum("标本面",[0,60,230.00]);
datum("台面点",[0,0,230.13]);
datum("台底点",[0,30,222.13]);
datum("槽壁A",[0,47.35,228.63]);
datum("槽壁B",[0,72.65,228.63]);
datum("槽底",[0,60,228.63]);
datum("通光孔轴心",[0,60,230.00]);
datum("后缘",[0,15,230.13]);
datum_cyl("通光孔",[0,60,226],[0,0,1],6);
