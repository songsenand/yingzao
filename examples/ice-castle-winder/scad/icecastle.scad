// ============================================================
// 冰雪城堡八线手摇绕线器 — 参数化 OpenSCAD 源
// 全自制、FDM / PLA；单位 mm，Z 向上；整机包络 <= 250^3
// 装配位姿见 assembly/assembly.json
// ============================================================
$fn = 40;
include <BOSL2/std.scad>
include <BOSL2/gears.scad>

// ---------------- 全局参数 ----------------
BASE_AF   = 196;
BASE_TOP  = 38;
LOW_Z     = 20;
MID_TOP   = 34;
TOP_T     = 4;
KEEP_AF   = 100;
KEEP_T    = 3;
KEEP_Z0   = 38;
KEEP_Z1   = 224;
NECK_Z0   = 216;
NECK_Z1   = 224;
NECK_OD   = 98;
NECK_ID   = 88;
NECK_GROOVE_Z = 219;
NSP       = 8;
DISC_T    = 2;
SPOOL_H   = 18;
SPOOL_R   = 42;
BARREL_R  = 20;
SPOOL_BORE_R = 7.2;
HUB_R     = 13;
STACK_Z0  = 54;
SPOOL_PITCH = SPOOL_H + DISC_T;      // 20
SHAFT_D   = 14;
SHAFT_FLAT_X = 3.5;
DCLEAR    = 3.25;
DBORE_R   = 7.2;
WHEEL_Z   = 27;
WORM_Y    = -17.3;
WHEEL_T   = 8;
WORM_MOD  = 1.2;
WHEEL_TEETH = 20;
WORM_STARTS = 2;
CRANK_X   = 106;
ARM_R     = 16;
CAP_Z0    = 216;
CAP_Z1    = 240;
SNOW_Z0   = 240;
SNOW_Z1   = 246;

function spool_z(i) = STACK_Z0 + DISC_T + SPOOL_H/2 + i*SPOOL_PITCH;
// 下 4 线开在正方位，上 4 线开在斜面（避开角塔）
function win_a(i) = i < 4 ? i*90 : 45 + (i-4)*90;

// ---------------- 2D 基础 ----------------
module oct2d(af) { rotate(22.5) circle(d=af/cos(22.5), $fn=8); }
module oct_prism(af, z0, z1) { translate([0,0,z0]) linear_extrude(z1-z0) oct2d(af); }
module square_prism(s, z0, z1) { translate([0,0,z0]) linear_extrude(z1-z0) square([s,s], center=true); }
module square_tube(so, si, z0, z1) { difference(){ square_prism(so,z0,z1); square_prism(si,z0-1,z1+1);} }
module oct_tube(af_out, af_in, z0, z1) {
  difference() { oct_prism(af_out,z0,z1); oct_prism(af_in,z0-1,z1+1); }
}
module arch2d(w,h) {
  polygon([[-w/2,0],[w/2,0],[w/2,h-w*0.55],[0,h],[-w/2,h-w*0.55]]);
}
// 尖拱窗：宽 Y、高 Z、厚 X，居中
module arch_x(w,h,d) {
  rotate([0,0,90]) rotate([90,0,0]) linear_extrude(d,center=true) arch2d(w,h);
}
module snowflake2d(r) {
  for (i=[0:5]) rotate(i*60) {
    hull() { circle(d=2.2); translate([r,0]) circle(d=2.2); }
    for (s=[-1,1]) rotate(s*55) hull() {
      translate([r*0.52,0]) circle(d=1.8);
      translate([r*0.82,0]) circle(d=1.4);
    }
  }
  circle(d=2.8*r*0.18);
}
module icicle(len, r=1.2) { translate([0,0,-len]) cylinder(r1=0, r2=r, h=len, $fn=12); }

module D_hole(h, r=DBORE_R) {
  union() {
    cylinder(r=r, h=h);
    translate([DCLEAR,0,-0.1]) cube([12,24,h+0.2], center=true);
  }
}
module D_shaft(z0, z1) {
  difference() {
    translate([0,0,z0]) cylinder(d=SHAFT_D, h=z1-z0);
    translate([SHAFT_FLAT_X,0,z0-0.1]) cube([12,24,z1-z0+0.2], center=true);
  }
}

// ---------------- 底座三件 ----------------
module base_lower() {
  difference() {
    union() {
      square_prism(204, 0, 6);
      square_prism(198, 6, 12);
      square_prism(192, 12, LOW_Z);
      translate([0,0,4]) cylinder(d=26, h=LOW_Z-4);   // 承压柱

    }
    translate([0,0,4]) oct_prism(180, 0, LOW_Z-3.9);
    for (i=[0:7]) rotate([0,0,i*45+22.5]) translate([BASE_AF/2-0.5,0,13])
      cube([3.2,1.6,7], center=true);
  }
}

module base_mid() {
  difference() {
    union() {
      square_tube(BASE_AF-6, BASE_AF-12, LOW_Z, MID_TOP);
      translate([93, WORM_Y, WHEEL_Z]) rotate([0,90,0]) cylinder(d=14, h=13);
      // 45° 支撑肋
      translate([94, WORM_Y-1.2, LOW_Z]) linear_extrude(2.4)
        polygon([[0,0],[12,0],[0,WHEEL_Z-LOW_Z]]);
    }
    translate([0,0,LOW_Z]) square_prism(BASE_AF-12, 0, MID_TOP-LOW_Z+1);
    translate([88, WORM_Y, WHEEL_Z]) rotate([0,90,0]) cylinder(d=8.6, h=22);
  }
}

module base_top() {
  difference() {
    union() {
      square_prism(BASE_AF, MID_TOP, BASE_TOP);
      translate([0,0,BASE_TOP-0.6]) cylinder(d=24, h=STACK_Z0-BASE_TOP+0.6);
    }
    translate([0,0,BASE_TOP-1]) cylinder(d=14.6, h=STACK_Z0-BASE_TOP+2);
    for (a=[45,135,225,315]) rotate([0,0,a]) translate([52,0,MID_TOP-0.1])
      cylinder(d=4.2, h=TOP_T+0.4);
    for (p=[[77,77],[-77,77],[-77,-77],[77,-77]])
      translate([p[0],p[1],MID_TOP-0.1]) cylinder(d=30.4, h=TOP_T+0.4);
    // 冰封护城河
    translate([0,0,BASE_TOP-2.8]) difference() {
      cylinder(d=144, h=3.0);
      cylinder(d=120, h=3.1);
    }
  }
}

// ---------------- 主塔 ----------------
module keep_window_cut(a, z) {
  rotate([0,0,a]) translate([KEEP_AF/2-KEEP_T/2+0.5, 0, z-9])
    arch_x(18, 18, KEEP_T+4);
}

module keep_window_dress(a, z) {
  rotate([0,0,a]) translate([KEEP_AF/2, 0, 0]) {
    // 窗台：在窗洞下缘之外，径向 4.6（压入墙 0.6），切向 18.6
    translate([-0.6,0,z-10.6]) cube([4.6,18.6,1.6]);
    // 拱心石
    translate([0.6,0,z+9.2]) rotate([45,0,0]) cube([4,4,1.8], center=true);
  }
}

module keep() {
  difference() {
    union() {
      difference() {
        oct_prism(KEEP_AF+12, KEEP_Z0, KEEP_Z0+3);
        oct_prism(KEEP_AF-8, KEEP_Z0-1, KEEP_Z0+4);
      }
      oct_tube(KEEP_AF, KEEP_AF-2*KEEP_T, KEEP_Z0+3, NECK_Z0);
      translate([0,0,NECK_Z0-0.5]) cylinder(d=NECK_OD, h=NECK_Z1-NECK_Z0+0.5);
      // 底部冰晶托座
      difference() {
        translate([0,0,KEEP_Z0+2.4]) linear_extrude(4.6, scale=100/112) oct2d(112);
        translate([0,0,KEEP_Z0+2]) oct_prism(94, 0, 5);
      }
    }
    // 塔身内腔（注意：body bore 94，颈 bore 88）
    translate([0,0,KEEP_Z0+2]) cylinder(d=KEEP_AF-6+0.01, h=NECK_Z0-KEEP_Z0-1);

    // 颈内孔
    translate([0,0,NECK_Z0-1]) cylinder(d=NECK_ID, h=NECK_Z1-NECK_Z0+2);
    for (i=[0:NSP-1]) keep_window_cut(win_a(i), spool_z(i));
    translate([0,0,NECK_GROOVE_Z]) difference() {
      cylinder(d=NECK_OD+4, h=2);
      cylinder(d=NECK_OD-2, h=2.001);
    }
    translate([0,0,NECK_Z1-1]) cylinder(d1=NECK_ID, d2=NECK_ID-2, h=1.01);
    // 4 个定位销孔
    for (a=[45,135,225,315]) rotate([0,0,a]) translate([52,0,KEEP_Z0-0.1])
      cylinder(d=4.2, h=4);
  }
  for (i=[0:NSP-1]) keep_window_dress(win_a(i), spool_z(i));
}

// ---------------- 冠 / 雪花 ----------------
module crown() {
  difference() {
    union() {
      translate([0,0,CAP_Z0]) difference() {
        cylinder(d=106, h=8.5);
        cylinder(d=NECK_OD+0.5, h=9.0);
        for (i=[0:3]) rotate([0,0,i*90])
          translate([0,0,2]) intersection() {
            difference() { cylinder(d=NECK_OD+1.6, h=2); cylinder(d=NECK_OD-1.4, h=2.1); }
            cube([NECK_OD, NECK_OD*0.62, 5], center=true);
          }
      }
      // 冠底压盘 + 预紧凸台
      translate([0,0,CAP_Z0+7.68]) cylinder(d=60, h=1.2);
      // 陡峭冰锥冠顶
      translate([0,0,CAP_Z0+8]) cylinder(d1=106, d2=24, h=16, $fn=16);
      // 8 个冠尖
      for (i=[0:7]) rotate([0,0,i*45]) translate([52,0,CAP_Z0+8])
        cylinder(d1=8, d2=0, h=14+5*(i%3), $fn=10);
      // 冠檐冰锥
      for (i=[0:7]) rotate([0,0,i*45+22.5])
        translate([51,0,CAP_Z0+8.6]) icicle(13+3*(i%2), 1.5);
    }
    translate([0,0,CAP_Z0-1]) cylinder(d=14.8, h=CAP_Z1-CAP_Z0+2);
  }
}

module snowflake_finial() {
  difference() {
    union() {
      translate([0,0,SNOW_Z0]) cylinder(d=16, h=6);
      translate([0,0,SNOW_Z0+3]) linear_extrude(3) snowflake2d(32);
    }
    translate([0,0,SNOW_Z0-1]) D_hole(h=SNOW_Z1-SNOW_Z0+2);
  }
}

// ---------------- 线轮 / 压盘 ----------------
module spool() {
  difference() {
    union() {
      cylinder(r=SPOOL_R, h=2);
      translate([0,0,SPOOL_H-2]) cylinder(r=SPOOL_R, h=2);
      cylinder(r=BARREL_R, h=SPOOL_H);
      cylinder(r=HUB_R, h=SPOOL_H);
    }
    translate([0,0,-1]) cylinder(r=SPOOL_BORE_R, h=SPOOL_H+2);

  }
  // 法兰外缘冰棱
  for (i=[0:11]) rotate([0,0,i*30]) translate([SPOOL_R-1.0,0,1.2])
    cylinder(d=1.6, h=SPOOL_H-2.4, $fn=8);
}

module disc() {
  difference() {
    cylinder(r=18, h=DISC_T);
    translate([0,0,-1]) D_hole(h=DISC_T+2);
    for (i=[0:5]) rotate([0,0,i*60]) translate([12.8,0,-0.5])
      cylinder(d=2.2, h=DISC_T+1, $fn=12);
  }
}

// ---------------- 轴 / 蜗轮 / 曲柄 ----------------
module main_shaft() {
  difference() {
    union() {
      translate([0,0,20]) cylinder(d=20, h=3.5);
      D_shaft(23.0, SNOW_Z1);
    }
  }
}

module shaft_clip() {
  difference() {
    cylinder(d=20, h=2);
    cylinder(d=14.5, h=3);
    translate([7,0,-1]) cube([10,6,4]);
  }
}

module worm_wheel() {
  difference() {
    intersection() {
      translate([0,0,WHEEL_Z]) worm_gear(
        mod=WORM_MOD, teeth=WHEEL_TEETH, worm_diam=10,
        worm_starts=WORM_STARTS, slices=16, gear_spin=0, crowning=0.1, backlash=0.4
      );
      // 齿顶修缘：把齿顶圆压到 r=13.3，避开蜗杆根圆（3.8）——原 13.83 会撞根圆 0.3
      translate([0,0,WHEEL_Z]) cylinder(r=13.3, h=10, center=true);
    }
    translate([0,0,WHEEL_Z-WHEEL_T/2-0.1]) D_hole(h=WHEEL_T+0.2);
  }
}

module crank_shaft() {
  translate([0,WORM_Y,WHEEL_Z]) {
    zrot(90) worm(mod=WORM_MOD, d=10, l=26, starts=WORM_STARTS, orient=BACK, backlash=0.4, $fn=36);
    translate([12,0,0]) rotate([0,90,0]) cylinder(d=8, h=94);
    // R0.5 圆角过渡：蜗杆端面 x=13 与 Ø8 轴外圆 (r4) 的凹角
    translate([13,0,0]) rotate([0,90,0]) rotate_extrude(convexity=8, $fn=32)
      translate([4,0,0]) difference() {
        square([0.5,0.5]);
        translate([0.5,0.5]) circle(r=0.5, $fn=32);
      }
    translate([105.5,0,0]) rotate([0,90,0]) difference() {
      cylinder(d=12, h=6);
      translate([3,0,0]) cube([12,24,12], center=true);
      // D 面两条棱 0.5x45 倒角
      translate([2.5,0,0]) rotate([0,0,45]) cube([0.7071,0.7071,12], center=true);
      translate([2.5,0,0]) rotate([0,0,-45]) cube([0.7071,0.7071,12], center=true);
    }
    // Ø8 -> Ø12 榫台阶 R0.5 圆角
    translate([106,0,0]) rotate([0,90,0]) rotate_extrude(convexity=8, $fn=32)
      translate([4,0,0]) difference() {
        square([0.5,0.5]);
        translate([0.5,0.5]) circle(r=0.5, $fn=32);
      }
  }
}

module handwheel() {
  difference() {
    union() {
      translate([0,0,0]) rotate([0,90,0]) difference() { cylinder(d=50, h=6); cylinder(d=38, h=6.1); }
      translate([0,0,0]) rotate([0,90,0]) cylinder(d=14, h=6);
      for (i=[0:3]) rotate([i*90,0,0]) translate([3,0,13]) cube([6,4,13], center=true);
      translate([3,0,22]) cube([6,4,4], center=true);
      // 手柄
      translate([5.2,0,24]) rotate([0,90,0]) cylinder(d=9, h=13.5);
      translate([18,0,24]) sphere(d=10);
    }
    translate([-1,0,0]) rotate([0,90,0]) D_hole(8, 6.2);
  }
}

// ---------------- 角塔 / 城墙 ----------------
module turret() {
  difference() {
    union() {
      translate([0,0,-4]) cylinder(d=30, h=4);
      cylinder(d=42, h=66);
      translate([0,0,62]) cylinder(d1=42, d2=48, h=4);
      translate([0,0,64]) cylinder(d=52, h=2.2);
      translate([0,0,65.5]) cylinder(d1=49, d2=0, h=34.5, $fn=32);
      translate([0,0,100]) sphere(d=6);
      for (i=[0:7]) rotate([0,0,i*45]) translate([22,0,66]) icicle(6+3*(i%3), 1.1);
      for (i=[0:7]) rotate([0,0,i*45+22.5]) translate([20.2,0,2])
        cylinder(d=2.6, h=62, $fn=10);
    }
    for (a=[0,180]) rotate([0,0,a]) translate([21,0,36])
      rotate([0,90,0]) linear_extrude(8, center=true) square([9,3], center=true);
  }
}

module wall(gate=false) {
  difference() {
    union() {
      translate([0,0,12]) cube([4,111.6,24], center=true);
      translate([-2.8,0,24]) cube([3.2,111.6,2], center=true);
      for (i=[0:4]) translate([0,-48+i*24,26]) cube([4,8,4], center=true);
      for (x=[-46,46]) translate([4.2,x,9]) cube([7,5,18], center=true);
    }
    for (x=[-32,32]) translate([x,0,14]) cube([3,6,7], center=true);
    if (gate) {
      rotate([90,0,0]) linear_extrude(8, center=true) arch2d(22,18);
      for (k=[-1:1]) translate([k*5.5,0,8]) cube([1.6,1.4,16], center=true);
      translate([0,0,9]) cube([14,1.4,1.6], center=true);
    } else {
      translate([0,2,12]) rotate([-90,0,0]) linear_extrude(2.2) snowflake2d(6.5);
    }
  }
}

// ---------------- 门楼 ----------------
module gatehouse() {
  difference() {
    union() {
      translate([0,-87.5,58]) cube([44,15,40], center=true);
      for (x=[-16,-8,0,8,16]) translate([x,-87.5,79.5]) cube([5,15,5], center=true);
      for (s=[-1,1]) {
        translate([s*20,-88,74]) cylinder(d=14, h=10);
        translate([s*20,-88,83.5]) cylinder(d1=17, d2=0, h=9.5);
        translate([s*20,-88,93]) sphere(d=5);
      }
    }
    translate([0,-87.5,38]) rotate([90,0,0]) linear_extrude(17, center=true) arch2d(26,22);
    for (k=[-2:2]) translate([k*5,-95,50]) cube([1.6,1.4,20], center=true);
    translate([0,-95,58]) cube([24,1.4,1.6], center=true);
  }
}

// ---------------- 小件 ----------------
module pin() { cylinder(d=4, h=8, $fn=16); }

module spring_washer() {
  difference() {
    union() {
      cylinder(r=17, h=1.2);
      translate([0,0,1.2]) cylinder(r1=17, r2=6.5, h=1.2);
    }
    translate([0,0,-0.1]) cylinder(r=7.4, h=3);
  }
}

module spring_stack() {
  for (i=[0:2]) translate([0,0,i*1.67]) spring_washer();
}

module thrust_washer() { difference() { cylinder(r=30, h=2); translate([0,0,-1]) cylinder(r=7.4, h=4); } }
module shim() { difference() { cylinder(r=17, h=0.6); translate([0,0,-1]) cylinder(r=7, h=3); } }

// ---------------- 预览 ----------------
module preview() {
  color("#8fb8d8") base_lower();
  color("#9cc6e2") base_mid();
  color("#b7d7ea") base_top();
  color("#cfe8f5") keep();
  color("#eaf7ff") crown();
  color("#f7fdff") snowflake_finial();
  color("#a9cfe6") for (p=[[77,77],[-77,77],[-77,-77],[77,-77]]) translate([p[0],p[1],38]) turret();
  color("#b9d8e8") translate([77,0,38]) wall(false);
  color("#b9d8e8") translate([-77,0,38]) rotate([0,0,180]) wall(false);
  color("#b9d8e8") translate([0,77,38]) rotate([0,0,90]) wall(false);
  color("#b9d8e8") translate([0,-77,38]) rotate([0,0,-90]) wall(true);
  color("#b9d8e8") gatehouse();
  color("#7fc4e8") for (i=[0:NSP-1]) translate([0,0,STACK_Z0+DISC_T+i*SPOOL_PITCH]) spool();
  color("#5f9fc4") for (i=[0:NSP+1]) translate([0,0,STACK_Z0+i*SPOOL_PITCH]) disc();
  color("#d7eefb") for (i=[0:2]) translate([0,0,216+i*1.3]) spring_washer();
  color("#d7eefb") translate([0,0,221]) thrust_washer();
  color("#e8f4fb") main_shaft();
  color("#4f8bb0") worm_wheel();
  color("#9fc6dc") translate([0,0,32]) shaft_clip();
  color("#6aa7c9") crank_shaft();
  color("#5b98bb") translate([106,WORM_Y,WHEEL_Z]) handwheel();
  color("#e8f4fb") for (a=[45,135,225,315]) rotate([0,0,a]) translate([52,0,32]) pin();
}

if (is_undef(SHOW_ALL) || SHOW_ALL) preview();
