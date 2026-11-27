# OpenYAM planning ghost

The WebXR GLB and Specs MeshBuilder data use the visual meshes from the OpenYAM
single-arm description selected by dimOS. Each link has one convex hull in its
URDF frame. The runtime model descriptor supplies joint transforms, including
the mimic finger. The asset's visual signature must match that descriptor.

Source model and meshes are in
[dim_description at f985334](https://github.com/dimensionalOS/dim_description/tree/f9853344bbc9fa00aade6ff3ffb7db6532d185e1/openyam_single).

To regenerate both clients' assets and their shared test fixture, run
`python clients/specs/tools/export_manipulation_mesh.py --from-dimos`
at the repository root with the installed dimOS planning environment.
