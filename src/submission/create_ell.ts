import { FieldMath } from "../reference/utils/FieldMath";
import { ELLSparseMatrix } from './matrices/matrices'; 

import { ExtPointType } from "@noble/curves/abstract/edwards";
import assert from 'assert'

export const prep_for_sort_method = (
    scalar_chunks: number[],
    scalar_chunk_idx: number,
    thread_idx: number,
) => {
    const pt_and_chunks = []
    for (let i = 0; i < scalar_chunks.length; i ++) {
        const pt_idx = thread_idx * scalar_chunks.length + i
        pt_and_chunks.push([pt_idx, scalar_chunks[i]])
    }

    pt_and_chunks.sort((a: number[], b: number[]) => {
        if (a[1] > b[1]) { return 1 }
        else if (a[1] < b[1]) { return -1 }
        return 0
    })

    const cluster_start_indices = [0]
    let prev_chunk = pt_and_chunks[0][1]
    for (let k = 1; k < pt_and_chunks.length; k ++) {
        if (prev_chunk !== pt_and_chunks[k][1]) {
            cluster_start_indices.push(k)
        }
        prev_chunk = pt_and_chunks[k][1]
    }

    const new_point_indices = pt_and_chunks.map((x) => x[0])
    return { new_point_indices, cluster_start_indices }
}

export const prep_for_cluster_method = (
    scalar_chunks: number[],
    scalar_chunk_idx: number,
    thread_idx: number,
) => {
    const new_point_indices: number[] = []
    const cluster_start_indices: number[] = [0]

    const clusters = new Map()
    for (let i = 0; i < scalar_chunks.length; i ++) {
        const pt_idx = thread_idx * scalar_chunks.length + i
        const c = scalar_chunks[i]
        const g = clusters.get(c)
        if (g == undefined) {
            clusters.set(c, [pt_idx])
        } else {
            g.push(pt_idx)
            clusters.set(c, g)
        }
    }

    for (const k of clusters.keys()) {
        const cluster = clusters.get(k)
        if (cluster.length === 1) {
            new_point_indices.push(cluster[0])
        } else {
            for (const c of cluster) {
                new_point_indices.unshift(c)
            }
        }
    }

    let prev_chunk = scalar_chunks[new_point_indices[0]]
    for (let i = 1; i < new_point_indices.length; i ++) {
        if (prev_chunk !== scalar_chunks[new_point_indices[i]]) {
            cluster_start_indices.push(i)
        }
        prev_chunk = scalar_chunks[new_point_indices[i]]
    }
    return { new_point_indices, cluster_start_indices }
}

// Compute a "plan" which helps the parent algo pre-aggregate the points which
// share the same scalar chunk.
export const gen_add_to = (
    chunks: number[]
): { add_to: number[], new_chunks: number[] } => {
    const new_chunks = chunks.map((x) => x)
    const occ = new Map()
    const track = new Map()
    for (let i = 0; i < chunks.length; i ++) {
        const chunk = chunks[i]
        if (occ.get(chunk) != undefined) {
            occ.get(chunk).push(i)
        } else {
            occ.set(chunk, [i])
        }

        track.set(chunk, 0)
    }

    const add_to = Array.from(new Uint8Array(chunks.length))
    for (let i = 0; i < chunks.length; i ++) {
        const chunk = chunks[i]
        const t = track.get(chunk)
        if (t === occ.get(chunk).length - 1 || chunk === 0) {
            continue
        }

        add_to[i] = occ.get(chunk)[t + 1]
        track.set(chunk, t + 1)
        new_chunks[i] = 0
    }

    // Sanity check
    assert(add_to.length === chunks.length)
    assert(add_to.length === new_chunks.length)

    return { add_to, new_chunks }
}

export function merge_points(
    points: ExtPointType[],
    add_to: number[],
    zero_point: ExtPointType,
) {
    // merged_points will contain points that have been accumulated based on common scalar chunks.
    // e.g. if points == [P1, P2, P3, P4] and scalar_chunks = [1, 1, 2, 3],
    // merged_points will equal [0, P1 + P2, P3, P4]
    const merged_points = points.map((x) => fieldMath.createPoint(x.ex, x.ey, x.et, x.ez))

    // Next, add up the points whose scalar chunks match
    for (let i = 0; i < add_to.length; i ++) {
        if (add_to[i] != 0) {
            const cur = merged_points[i]
            merged_points[add_to[i]] = merged_points[add_to[i]].add(cur)
            merged_points[i] = zero_point
        }
    }

    return merged_points
}

const fieldMath = new FieldMath()
const ZERO_POINT = fieldMath.createPoint(
    BigInt(0),
    BigInt(1),
    BigInt(0),
    BigInt(1),
)

export function create_ell(
    points: ExtPointType[],
    scalar_chunks: number[],
    num_threads: number,
) {
    const num_cols = scalar_chunks.length / num_threads
    const data: ExtPointType[][] = []
    const col_idx: number[][] = []
    const row_length: number[] = []

    for (let i = 0; i < num_threads; i ++) {
        // Take each num_thread-th chunk only (each row)
        const chunks: number[] = []
        for (let j = 0; j < num_cols; j ++) {
            const idx = i * num_cols + j
            const c = scalar_chunks[idx]
            chunks.push(c)
        }

        // Pre-aggregate points per row
        const { add_to, new_chunks } = gen_add_to(chunks)
        const merged_points = merge_points(
            points,
            add_to,
            ZERO_POINT,
        )

        const pt_row: ExtPointType[] = []
        const idx_row: number[] = []
        for (let j = 0; j < num_cols; j ++) {
            const point_idx = num_cols * i + j
            const pt = merged_points[point_idx]
            if (new_chunks[point_idx] !== 0) {
                pt_row.push(pt)
                idx_row.push(new_chunks[point_idx])
            }
        }
        data.push(pt_row)
        col_idx.push(idx_row)
        row_length.push(pt_row.length)
    }
    const ell_sm = new ELLSparseMatrix(data, col_idx, row_length)
    return ell_sm

    /*
    // Precompute the indices for the points to merge
    const { add_to, new_chunks } = gen_add_to(scalar_chunks)
    const merged_points = merge_points(
        points,
        add_to,
        ZERO_POINT,
    )

    // Create an ELL sparse matrix using merged_points and new_chunks
    const num_cols = points.length / num_threads
    const data: ExtPointType[][] = []
    const col_idx: number[][] = []
    const row_length: number[] = []
    
    for (let i = 0; i < num_threads; i ++) {
        const pt_row: ExtPointType[] = []
        const idx_row: number[] = []
        for (let j = 0; j < num_cols; j ++) {
            const point_idx = num_cols * i + j
            const pt = merged_points[point_idx]
            if (new_chunks[point_idx] !== 0) {
                pt_row.push(pt)
                idx_row.push(new_chunks[point_idx])
            }
        }
        data.push(pt_row)
        col_idx.push(idx_row)
        row_length.push(pt_row.length)
    }
    const ell_sm = new ELLSparseMatrix(data, col_idx, row_length)
    return ell_sm
    */
}
