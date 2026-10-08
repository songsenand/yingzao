/* Native ceiling for the MPM kernel (P2G scatter → grid update → G2P gather).
 *
 * Why this exists: the criterion is "能迁就迁 Python，只有明确负收益才不做" and
 * the user also said "需要高性能的，还需要使用 cpp 或者 rust 来实现". So when a
 * kernel is the hot spot, the decision needs THREE numbers on the same workload:
 * the hand-written TS kernel (data/bench/mpm-scaling.json), the best numpy
 * formulation (scripts/measure-python-gains.mjs M1), and a compiled kernel.
 * This file provides the third.
 *
 * Same workload as the TS bench and the numpy proxy: grid 24×24×100 cells,
 * quadratic B-spline weights over 27 neighbours per particle, particle counts
 * 8,820 / 70,560 / 261,950, 20 steps. No allocation inside the loop.
 *
 * Build & run:
 *   gcc -O3 -march=native -o .tmp-mpm-bench scripts/native/mpm-kernel-bench.c -lm
 *   ./.tmp-mpm-bench
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

#define NX 24
#define NY 24
#define NZ 100
#define N (NX * NY * NZ)
#define DX 2.0
#define STEPS 20

static double grid_m[N];
static double grid_mvx[N], grid_mvy[N], grid_mvz[N];
static double gvx[N], gvy[N], gvz[N];

static void step(int P, const double *px, const double *py, const double *pz,
                 const double *vx, const double *vy, const double *vz,
                 double *ox, double *oy, double *oz) {
  for (int i = 0; i < N; i++) {
    grid_m[i] = 0.0;
    grid_mvx[i] = 0.0;
    grid_mvy[i] = 0.0;
    grid_mvz[i] = 0.0;
  }

  for (int p = 0; p < P; p++) {
    const double ux = px[p] / DX - 0.5, uy = py[p] / DX - 0.5, uz = pz[p] / DX - 0.5;
    const int ix = (int)floor(ux), iy = (int)floor(uy), iz = (int)floor(uz);
    const double fx = ux - ix, fy = uy - iy, fz = uz - iz;
    const double wx[3] = {0.5 * (1 - fx) * (1 - fx), 0.75 - (fx - 0.5) * (fx - 0.5), 0.5 * fx * fx};
    const double wy[3] = {0.5 * (1 - fy) * (1 - fy), 0.75 - (fy - 0.5) * (fy - 0.5), 0.5 * fy * fy};
    const double wz[3] = {0.5 * (1 - fz) * (1 - fz), 0.75 - (fz - 0.5) * (fz - 0.5), 0.5 * fz * fz};
    for (int a = 0; a < 3; a++) {
      const int gx = ix + a - 1;
      if (gx < 0 || gx >= NX) continue;
      for (int b = 0; b < 3; b++) {
        const int gy = iy + b - 1;
        if (gy < 0 || gy >= NY) continue;
        for (int c = 0; c < 3; c++) {
          const int gz = iz + c - 1;
          if (gz < 0 || gz >= NZ) continue;
          const int idx = (gx * NY + gy) * NZ + gz;
          const double w = wx[a] * wy[b] * wz[c];
          grid_m[idx] += w;
          grid_mvx[idx] += w * vx[p];
          grid_mvy[idx] += w * vy[p];
          grid_mvz[idx] += w * vz[p];
        }
      }
    }
  }

  for (int i = 0; i < N; i++) {
    const double m = grid_m[i];
    const double inv = m > 1e-12 ? 1.0 / m : 0.0;
    gvx[i] = grid_mvx[i] * inv;
    gvy[i] = grid_mvy[i] * inv;
    gvz[i] = grid_mvz[i] * inv - 9.8 * (1.0 / 60.0);
  }

  for (int p = 0; p < P; p++) {
    const double ux = px[p] / DX - 0.5, uy = py[p] / DX - 0.5, uz = pz[p] / DX - 0.5;
    const int ix = (int)floor(ux), iy = (int)floor(uy), iz = (int)floor(uz);
    const double fx = ux - ix, fy = uy - iy, fz = uz - iz;
    const double wx[3] = {0.5 * (1 - fx) * (1 - fx), 0.75 - (fx - 0.5) * (fx - 0.5), 0.5 * fx * fx};
    const double wy[3] = {0.5 * (1 - fy) * (1 - fy), 0.75 - (fy - 0.5) * (fy - 0.5), 0.5 * fy * fy};
    const double wz[3] = {0.5 * (1 - fz) * (1 - fz), 0.75 - (fz - 0.5) * (fz - 0.5), 0.5 * fz * fz};
    double sx = 0, sy = 0, sz = 0;
    for (int a = 0; a < 3; a++) {
      const int gx = ix + a - 1;
      if (gx < 0 || gx >= NX) continue;
      for (int b = 0; b < 3; b++) {
        const int gy = iy + b - 1;
        if (gy < 0 || gy >= NY) continue;
        for (int c = 0; c < 3; c++) {
          const int gz = iz + c - 1;
          if (gz < 0 || gz >= NZ) continue;
          const int idx = (gx * NY + gy) * NZ + gz;
          const double w = wx[a] * wy[b] * wz[c];
          sx += gvx[idx] * w;
          sy += gvy[idx] * w;
          sz += gvz[idx] * w;
        }
      }
    }
    ox[p] = sx;
    oy[p] = sy;
    oz[p] = sz;
  }
}

int main(void) {
  const int counts[3] = {8820, 70560, 261950};
  for (int ci = 0; ci < 3; ci++) {
    const int P = counts[ci];
    double *px = malloc(sizeof(double) * P), *py = malloc(sizeof(double) * P), *pz = malloc(sizeof(double) * P);
    double *vx = calloc(P, sizeof(double)), *vy = calloc(P, sizeof(double)), *vz = calloc(P, sizeof(double));
    double *ox = calloc(P, sizeof(double)), *oy = calloc(P, sizeof(double)), *oz = calloc(P, sizeof(double));
    unsigned int seed = 42;
    for (int p = 0; p < P; p++) {
      seed = seed * 1103515245u + 12345u; px[p] = ((seed >> 8) & 0xffff) / 65535.0 * ((NX - 4) * DX) + 2 * DX;
      seed = seed * 1103515245u + 12345u; py[p] = ((seed >> 8) & 0xffff) / 65535.0 * ((NY - 4) * DX) + 2 * DX;
      seed = seed * 1103515245u + 12345u; pz[p] = ((seed >> 8) & 0xffff) / 65535.0 * ((NZ - 4) * DX) + 2 * DX;
    }
    step(P, px, py, pz, vx, vy, vz, ox, oy, oz); /* warm-up */
    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    for (int s = 0; s < STEPS; s++) {
      step(P, px, py, pz, vx, vy, vz, ox, oy, oz);
      for (int p = 0; p < P; p++) { vx[p] = ox[p]; vy[p] = oy[p]; vz[p] = oz[p]; }
    }
    clock_gettime(CLOCK_MONOTONIC, &t1);
    const double ms = ((t1.tv_sec - t0.tv_sec) * 1e3 + (t1.tv_nsec - t0.tv_nsec) / 1e6) / STEPS;
    printf("particles=%-7d ms/step=%.2f\n", P, ms);
    free(px); free(py); free(pz); free(vx); free(vy); free(vz); free(ox); free(oy); free(oz);
  }
  return 0;
}
