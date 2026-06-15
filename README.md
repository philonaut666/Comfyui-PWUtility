# Comfyui-PWUtility
Contain a some useful nodes, like bool to set group state, group switch state advanced.

## Bool Group Switch节点
设置多个节点组的true和false状态，通过通过设置bool值来统一进行切换，以达到通过bool来控制工作流的效果。

<img width="828" height="1000" alt="BoolGroupSwitch" src="https://github.com/user-attachments/assets/f0931173-31bc-4110-9ae0-ae18fda6d89b" />

该节点要位于设置组们的前方。
- trigger用于输入并在data_out输出，不会改变数据。当Bool Group Switch连接在要设置的组们的前方，数据从trigger入从data_out出再流入最近的要设置的组，就控制了生成的顺序，防止先跑这些组再跑这个节点。
- interrupt_node_id：输入一个节点的ID，当执行到该节点时，流程会被打断，然后重新执行，用这样的方式来设置组们的状态。该节点最好是位于Bool Group Switch下游，并且不参与设置组们的执行，同时又很轻的条件。当前面没有clear cache之类的节点时，前面跑过的节点不会重新跑。id=0则不会打断，由comfyui执行工作流。

## Group Switch ADV节点：
组的快速开关并可联动其它组进行联级开关。

<img width="673" height="480" alt="GroupSwitchADV1" src="https://github.com/user-attachments/assets/0103910a-87d5-496d-9a05-695074e6ea68" />

Linkage Config中，通过点击右侧加号添加组并设置组的状态。组的左侧+可快速添加该组另一种状态。
一个组(Group1)可以联动另一个组（Group2)并进而联动Group2联动的Group3。但是当Group1中也设置Group3并且与Group2中的状态矛盾时，以Group1也就是主动切换的那个为准。

<img width="419" height="318" alt="GroupSwitchADV2" src="https://github.com/user-attachments/assets/146a684a-89d1-4042-8bea-92d7b8964e19" />

## License

MIT

## Credits

- [zhihui_nodes_comfyui](https://github.com/zhihui6/zhihui_nodes_comfyui) Group Switch Manager
