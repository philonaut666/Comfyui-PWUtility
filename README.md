# Comfyui-PWUtility
Contain a some useful nodes, like bool to set group state, group switch state advanced.

## Bool Group Switch节点
预先设置多个节点组们在true和false下的状态，通过bool值来统一进行切换，以达到通过bool来控制工作流的效果。

<img width="828" height="1000" alt="BoolGroupSwitch" src="https://github.com/user-attachments/assets/f0931173-31bc-4110-9ae0-ae18fda6d89b" />

该节点要位于设置组们的前方。这样可以让流程先通过这个节点来设置组的状态。在trigger中输入的数据从data_out输出(不会改变数据)。再流入最近的要设置的组，就控制了生成的顺序，防止先跑这些组再跑这个节点。Trigger并不是必须的，但是要控制具体的生成顺序最好是使用trigger。

interrupt_node_id：输入一个节点的ID，当执行到该节点时，流程会被打断，然后重新执行，用这样的方式来设置组们的状态。该节点最好是位于Bool Group Switch下游，并且不参与设置组们的执行，同时又很轻的节点。当前面没有clear cache之类的节点时，前面跑过的节点不会重新跑。id=0则不会打断，由comfyui执行工作流。
comfyui在run工作流之前会输入整个画布所有节点的状态，因此通过这个节点调整的状态(即使视觉上改变了，实际上还是在跑的）只能在下次运行时才起效，尤其是组中有采样之类的很重的节点，就很浪费时间，因此要进行打断再重跑的方式。

Comfyui的switch类的节点，除了有lazy标记的（比如anyswitch), run的时候基本上两条路都会运行一下，选择需要的那条，如果有比较重的节点，就很浪费时间了，只有bypass/mute这种才是真正的不运行。

## Group Switch ADV节点：
组的快速开关并可联动其它组进行联级开关。

<img width="673" height="480" alt="GroupSwitchADV1" src="https://github.com/user-attachments/assets/0103910a-87d5-496d-9a05-695074e6ea68" />

Linkage Config中，通过点击右侧加号添加组并设置组的状态。组的左侧+可快速添加该组另一种状态。
一个组(Group1)可以联动另一个组（Group2)并进而联动Group2联动的Group3。但是当Group1中也设置Group3并且与Group2中的状态矛盾时，以Group1也就是主动切换的那个为准。

<img width="419" height="318" alt="GroupSwitchADV2" src="https://github.com/user-attachments/assets/146a684a-89d1-4042-8bea-92d7b8964e19" />

## Image Loader PW：
本地上传图片(可多图），并调整尺寸。

### Upload Images：本地上传图片，可多图批量上传。
- 支持拖拽上传。
- 支持拖拽改变顺序。
- 图片中心出现✂️图案可对图片进行手动crop。

### scale mode: 选择缩放方式。
#### scale dimensions：设置宽和高。
- 长宽都为0则是保持原图尺寸。注意，此时是绕开multiple_of的，真正的原图不做任何修改直出！
- 但是会遇到比例问题，通过下面的resize_method来进行计算，会将长和宽更快达到给定值的设置为给定值，另一边根据resize mothod的设定的方式重新进行计算。

### multiple_of：要求长宽都能被该数值整除。

### resize_method： 选择用于处理比例的方式。
- 包括keep proportion保持原图比例，stretch拉伸，crop, pad。
- 但是可能造成与multiple_of的值的矛盾：当选择keep proportion，且保持原图比例导致长宽某一边的尺寸无法满足被multiple_of整除时，会自动降级为stretch，造成轻微形变（通常不超过1%）以满足能被multiple of整除的要求。选择pad或者crop，则会严格计算出multiple of的倍数作为边界框进行crop或者pad填充尺寸。
- crop：先按照比例进行缩放到外圈覆盖目标尺寸，然后根据crop_position计算裁剪起始坐标 x 和 y，从而精准切出目标画面。

## License

MIT

## Credits

- [zhihui_nodes_comfyui](https://github.com/zhihui6/zhihui_nodes_comfyui) Group Switch Manager
- [WhatDreamsCost-ComfyUI](https://github.com/WhatDreamsCost/WhatDreamsCost-ComfyUI)
- [myWhatDreamsCost-ComfyUI](https://github.com/huanggou666/myWhatDreamsCost-ComfyUI)
