// Layout locks preserve the selected anchor without quantizing coordinates.
export function translatePosition(block,dx,dy,locks={}){return {...block,x:locks.x?block.x:block.x+dx,y:locks.y?block.y:block.y+dy};}
export function constrainPosition(block,candidate,locks={}){return {...candidate,x:locks.x?block.x:candidate.x,y:locks.y?block.y:candidate.y};}
