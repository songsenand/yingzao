// 外购发条（参考几何，不打印）：0.25 x 5 x ~400，4.5 圈
$fn = 64;
A = [4, 0];
N = 4.5; RES = 540;
th0 = 180;
outer = [for (i=[0:RES]) let(t=i/RES, a=th0+t*N*360, r=2.75+(8.35-2.75)*t)
           [A[0]+r*cos(a), A[1]+r*sin(a)]];
inner = [for (i=[RES:-1:0]) let(t=i/RES, a=th0+t*N*360, r=2.75+(8.35-2.75)*t-0.25)
           [A[0]+r*cos(a), A[1]+r*sin(a)]];
module part() { translate([0,0,8.4]) linear_extrude(2.8) polygon(concat(outer, inner)); }
datum_axis("轴A",[4,0,9],[0,0,1]);
part();
