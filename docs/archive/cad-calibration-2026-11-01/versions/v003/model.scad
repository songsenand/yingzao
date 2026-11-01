$fn=48;
// 同样 40 长、Ø6 的胶囊杆，两端为球面收口 —— 平端面检测的负样本
hull(){
  translate([-17,0,0]) sphere(r=3);
  translate([17,0,0]) sphere(r=3);
}
