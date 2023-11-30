import React from "react";

export default class PageHomeOne extends React.Component<{pageNum: any}, {pageNum: ''}> {


    render() {
        return (
         <>
             <div>Page/1</div>
             {this.props.pageNum}
         </>
        );
    }
}