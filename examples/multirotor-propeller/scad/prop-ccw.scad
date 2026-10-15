// ============================================================================
//  Ø144 多旋翼螺旋桨（叶长 60mm）· 3 叶 · 一体 FDM 打印
//  ---------------------------------------------------------------------------
//  坐标系：z 轴 = 桨轴；桨毂底面 z = 0（也就是打印平台面）；叶尖半径 72mm。
//
//  旋向
//    HAND =  1  正桨：俯视逆时针（绕 +Z）旋转 → 推力沿 +Z
//    HAND = -1  反桨：正桨关于 XZ 平面（y→−y）镜像；叶片与 M2 孔方位不变，
//                     所以正反桨能装同一个电机接口（四轴对角一正一反）
//
//  桨毂即电机安装座，接口见文件末尾 datum_* 声明：
//    Ø5.2 中心轴孔（配 Ø5 电机轴）+ M5 螺母/垫圈沉台 + 3×M2 沉头防转孔（Ø16 分布圆）
//
//  打印：桨毂底面朝下平放，一体成形、零支撑。叶片下缘离电机钟壳顶面 ≈0.96mm。
//  叶根起于 R_EMBED=6 而不是 12：起始端面必须整个躲进 Ø26 桨毂里，否则会在毂外
//  露出一块平端面（既难看，又会让"对面壁厚"射线在退化三角面上量出假的薄壁）。
// ============================================================================

/* [桨叶] */
BLADE_LEN  = 60;     // PARAMS 叶片径向长度（叶根→叶尖）mm
R_ROOT     = 12;     // PARAMS 叶长起算半径（= 叶根"名义"半径）mm
R_EMBED    = 6;      // 叶根埋入桨毂的半径（仅为把端面藏进毂内）
CHORD_ROOT = 15;     // PARAMS 叶根弦长（在 R_ROOT 处）mm
CHORD_TIP  = 8;      // PARAMS 叶尖弦长 mm
THICK      = 0.17;   // PARAMS 翼型厚度比（NACA 4 位）
TE_T_BASE  = 1.1;    // PARAMS 基准截面(叶根)前后缘厚度 mm；随弦长同比例缩放
CAMBER     = 0.04;   // PARAMS 翼型最大弯度比
CAMBER_POS = 0.4;    // 最大弯度位置（弦长比）
PITCH_ROOT = 15.5;   // PARAMS 叶根桨距角（在 R_ROOT 处）deg
PITCH_TIP  = 9.5;    // PARAMS 叶尖桨距角 deg
BLADES     = 3;      // PARAMS 叶片数
HAND       = 1;      // PARAMS 1=正桨(CCW)  -1=反桨(CW)

/* [桨毂 / 电机接口] */
HUB_R      = 13;     // PARAMS 桨毂外半径 mm
HUB_T      = 7;      // PARAMS 桨毂厚度 mm
Z_PITCH    = 4.45;   // PARAMS 桨距轴高度（自桨毂底面）mm
BORE_D     = 5.2;    // PARAMS 中心轴孔直径（配 Ø5 电机轴）
PCD_M2     = 16;     // PARAMS M2 防转螺钉分布圆直径 mm
M2_D       = 2.4;    // PARAMS M2 通孔直径
M2_HEAD_D  = 4.3;    // PARAMS M2 90° 沉头锥最大直径
SEAT_D     = 11.5;   // PARAMS M5 螺母/垫圈沉台直径
SEAT_T     = 2.0;    // PARAMS 沉台深度 mm（座面 z = HUB_T − SEAT_T = 5.0）

// ---- 派生量 ----------------------------------------------------------------
// 弦长与桨距角都沿半径**线性**变化，并锚定在两个说得出名字的点上：
//   (R_ROOT, CHORD_ROOT) 与 (R_TIP, CHORD_TIP)； (R_ROOT, PITCH_ROOT) 与 (R_TIP, PITCH_TIP)
// linear_extrude 的 twist/scale 是"从拉伸起点 R_EMBED 线性变化到 R_TIP"，所以起点值
// 要由锚点反算（一次线性方程的解，不是近似）——否则参数名说的位置和真实位置会差一截。
R_TIP    = R_ROOT + BLADE_LEN;                   // 叶尖半径 = 72
SPAN     = R_TIP - R_EMBED;                      // 拉伸长度 = 66
K        = (R_ROOT - R_EMBED) / SPAN;            // 叶根在拉伸段里的位置比例
C_EMBED  = (CHORD_ROOT - K*CHORD_TIP) / (1 - K); // 起点弦长 → 保证 c(R_ROOT)=CHORD_ROOT
SCALE_Z  = CHORD_TIP / C_EMBED;                  // linear_extrude 的 scale
B_EMBED  = (PITCH_ROOT - K*PITCH_TIP) / (1 - K); // 起点桨距角 → 保证 b(R_ROOT)=PITCH_ROOT
// 注意：linear_extrude 的 twist 转向与 2D rotate() 相反（顺时针为正），
// 因此要让桨距角随半径**减小**，这里必须取正号。tools/check-pitch.py 是它的判据。
TWIST    = B_EMBED - PITCH_TIP;
X_PITCH  = 0.30;                                 // 桨距轴在弦长 30% 处（自前缘）
Y_SIGN   = (HAND < 0) ? -1 : 1;
R_EXIT   = 8.0;                                  // 叶根后缘露出桨毂外圆(r=13)的大致站位

// ---- NACA 4 位翼型（角度制；OpenSCAD 的 sin/cos/atan 都是度）---------------
// 厚度函数上叠加 TE_T_BASE/2 的常量偏置：把收敛成尖点的前/后缘变成钝缘。
// FDM 打不出零厚度刀刃边——那几层会被切片器直接丢掉或拉丝。
// 注意偏置是**弦长比例**，会和翼型一起被 scale 缩放 ⇒ 叶尖钝缘 ≈0.51×基准值。
function naca_t(x, t) = 5*t*(0.2969*sqrt(x) - 0.1260*x - 0.3516*x*x + 0.2843*x*x*x - 0.1036*x*x*x*x);
function naca_c(x, m, p) = x < p ? m/(p*p)*(2*p*x - x*x) : m/((1-p)*(1-p))*((1-2*p) + 2*p*x - x*x);
function naca_dc(x, m, p) = x < p ? 2*m/(p*p)*(p - x) : 2*m/((1-p)*(1-p))*(p - x);

// 闭合翼型轮廓：前缘在 +x（profile_x = (xp − x_naca)·c），弦长中 30% 处在原点。
function profile_pts(c, t, m, p, xp, n, te) =
  let(xs = [for (i = [0:n]) (1 - cos(180*i/n))/2], off = te/(2*c))
  concat(
    [for (i = [0:n])
       let(x = xs[i], yt = naca_t(x,t) + off, yc = naca_c(x,m,p), th = atan(naca_dc(x,m,p)))
       [ (xp - (x - yt*sin(th))) * c, (yc + yt*cos(th)) * c ]],
    [for (i = [n-1:-1:1])
       let(x = xs[i], yt = naca_t(x,t) + off, yc = naca_c(x,m,p), th = atan(naca_dc(x,m,p)))
       [ (xp - (x + yt*sin(th))) * c, (yc - yt*cos(th)) * c ]]
  );

// 叶片截面上的点：r 处、弦长比例 xf 处（xf = +0.30 前缘，−0.70 后缘）
function c_at(r) = C_EMBED + (CHORD_TIP - C_EMBED) * (r - R_EMBED) / SPAN;
function b_at(r) = B_EMBED + (PITCH_TIP - B_EMBED) * (r - R_EMBED) / SPAN;
function sec(r, xf) = [ r,
                        Y_SIGN * xf * c_at(r) * cos(b_at(r)),
                        Z_PITCH + xf * c_at(r) * sin(b_at(r)) ];
// 叶根最低点 = 后缘下棱（钝缘的下沿）。叶片离电机钟壳顶面最近的就是它。
function sec_lo(r) = [ r,
                       Y_SIGN * ((X_PITCH - 1)*c_at(r)*cos(b_at(r)) + (TE_T_BASE/2)*sin(b_at(r))),
                       Z_PITCH + (X_PITCH - 1)*c_at(r)*sin(b_at(r)) - (TE_T_BASE/2)*cos(b_at(r)) ];

// ---- 叶片 ------------------------------------------------------------------
// 2D 轮廓先绕桨距轴转 B_EMBED（正角 = 前缘抬起 = 正桨距），再用带 twist/scale 的
// linear_extrude 沿径向拉出；multmatrix 把「拉伸轴 z → 径向 +x、轮廓 x → 周向 y、
// 轮廓 y → 轴向 z」，于是 twist 正好绕径向轴、成为螺旋桨的螺距扭转。
module blade_at(az) {
  rotate([0, 0, az])
    translate([R_EMBED, 0, Z_PITCH])
      multmatrix([[0,0,1,0],[1,0,0,0],[0,1,0,0],[0,0,0,1]])
        linear_extrude(height = SPAN, twist = TWIST, scale = SCALE_Z, slices = 64, convexity = 10)
          rotate(B_EMBED)
            polygon(profile_pts(C_EMBED, THICK, CAMBER, CAMBER_POS, X_PITCH, 30, TE_T_BASE));
}

// ---- 桨毂 ------------------------------------------------------------------
module hub() {
  difference() {
    cylinder(r = HUB_R, h = HUB_T, $fn = 96);
    // 中心轴孔（Ø5 电机轴，滑配）
    translate([0,0,-1]) cylinder(d = BORE_D, h = HUB_T + 2, $fn = 64);
    // M5 螺母 + 垫圈沉台（座面 z = 5.0）
    translate([0,0,HUB_T - SEAT_T]) cylinder(d = SEAT_D, h = SEAT_T + 1, $fn = 96);
    // 3× M2 沉头通孔（方位 60°/180°/300°，正好落在两条叶片之间）
    for (i = [0:BLADES-1]) rotate([0,0,60 + i*360/BLADES]) {
      translate([PCD_M2/2, 0, -1]) cylinder(d = M2_D, h = HUB_T + 2, $fn = 48);
      translate([PCD_M2/2, 0, HUB_T - (M2_HEAD_D - M2_D)/2])
        cylinder(d1 = M2_D, d2 = M2_HEAD_D, h = (M2_HEAD_D - M2_D)/2, $fn = 48);
      translate([PCD_M2/2, 0, HUB_T]) cylinder(d = M2_HEAD_D, h = 1, $fn = 48);
    }
  }
}

module prop() {
  hub();
  for (i = [0:BLADES-1]) blade_at(i * 360/BLADES);
}

// 反桨 = 关于 XZ 平面镜像：叶片/M2 孔方位不变，桨距与弯度反向。
if (HAND < 0) mirror([0,1,0]) prop(); else prop();

// ---- 装配锚点（世界坐标；不参与网格）--------------------------------------
datum("叶根前缘点", sec(R_ROOT, X_PITCH));
datum("叶根后缘点", sec(R_ROOT, X_PITCH - 1));
datum("叶根最低点", sec_lo(R_EXIT));            // 露出桨毂处的最低点
datum("叶尖前缘点", sec(R_TIP,  X_PITCH));
datum("叶尖后缘点", sec(R_TIP,  X_PITCH - 1));
datum_plane("桨毂底面", [0, 0, 0], [0, 0, 1]);
datum_plane("桨毂顶面", [0, 0, HUB_T], [0, 0, 1]);
datum_plane("螺母座面", [0, 0, HUB_T - SEAT_T], [0, 0, 1]);
datum_cyl("中心轴孔",   [0, 0, 0], [0, 0, 1], BORE_D/2);
datum_axis("中心轴孔轴", [0, 0, 0], [0, 0, 1]);
datum_cyl("螺母座孔", [0, 0, HUB_T - SEAT_T], [0, 0, 1], SEAT_D/2);
for (i = [0:BLADES-1])
  datum_cyl(str("M2孔", i+1),
            [PCD_M2/2*cos(60 + i*360/BLADES), PCD_M2/2*sin(60 + i*360/BLADES), 0],
            [0, 0, 1], M2_D/2);