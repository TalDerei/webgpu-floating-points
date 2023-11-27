@group(0) @binding(0)
var<storage, read> scalars: array<u32>;
@group(0) @binding(1)
var<storage, read_write> result: array<u32>;

const NUM_SUBTASKS = {{ num_subtasks }}u;
const CHUNK_SIZE = {{ chunk_size }}u;

{{ > extract_word_from_bytes_le_funcs }}

@compute
@workgroup_size({{ workgroup_size }})
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let gidx = global_id.x; 
    let gidy = global_id.y; 
    let id = gidx * {{ num_y_workgroups }} + gidy;

    var scalar_bytes: array<u32, 16>;
    for (var i = 0u; i < 16u; i ++) {
        scalar_bytes[15u - i] = scalars[id * 16 + i];
    }

    for (var i = 0u; i < NUM_SUBTASKS - 1u; i ++) {
        result[id * NUM_SUBTASKS + i] = extract_word_from_bytes_le(scalar_bytes, i);
    }

    result[id * NUM_SUBTASKS + NUM_SUBTASKS - 1u] = scalar_bytes[0] >> (((NUM_SUBTASKS * CHUNK_SIZE - 256u) + 16u) - CHUNK_SIZE);
}
