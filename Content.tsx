import React from "react";

type DateState = {
    date: Date | null;
    msg: string;
};
export default class Content extends React.Component {

    declare state: DateState
    async fetchData() {
        const response = await fetch("/data", {
            method: "GET",
            headers: { "Content-Type": "application/json" },
        });
        const data = await response.json();

        this.setState({
            msg: data.time
        })
    }

    async componentDidMount() {
        setInterval(async () => {
            await this.fetchData()
        }, 2000);
    }

    constructor(props) {
        super(props);
        this.state = { date: null, msg: 'closed'};
    }

    render() {
        return (
         <>
             <div>{this.state.msg}</div>
         </>
        );
    }
};
